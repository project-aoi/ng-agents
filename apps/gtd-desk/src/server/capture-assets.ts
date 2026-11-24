import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, realpath, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { NgError } from "@ng/protocol";
import { CAPTURE_ASSET_PREFIX, MAX_SAVED_IMAGE_BYTES, MAX_IMAGE_EDGE, isImageType,
  type ImageType, type CaptureImageUpload, type SavedCaptureImage, type CaptureImageData } from "../shared/capture-assets";

const extensions: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const bad = (message: string): never => { throw new NgError("invalid_argument", message); };
const missing = (): never => { throw new NgError("not_found", "图片暂不可用"); };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const absent = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/** Bounded container headers, not a claim that every pixel has been decoded. */
export function imageDimensions(b: Buffer, type: ImageType): { width: number; height: number } {
  try {
    if (type === "image/png" && b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
        b.readUInt32BE(8) === 13 && b.toString("ascii", 12, 16) === "IHDR")
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (type === "image/gif" && b.length >= 13 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)))
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (type === "image/jpeg" && b.length >= 4 && b[0] === 255 && b[1] === 216) {
      let p = 2;
      while (p + 4 <= b.length) {
        if (b[p++] !== 255) break;
        while (b[p] === 255) p++;
        const marker = b[p++]!;
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        const size = b.readUInt16BE(p);
        if (size < 2 || p + size > b.length) break;
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8)
          return { width: b.readUInt16BE(p + 5), height: b.readUInt16BE(p + 3) };
        p += size;
      }
    }
    if (type === "image/webp" && b.length >= 20 && b.toString("ascii", 0, 4) === "RIFF" &&
        b.toString("ascii", 8, 12) === "WEBP" && b.readUInt32LE(4) + 8 === b.length) {
      const chunk = b.toString("ascii", 12, 16), size = b.readUInt32LE(16);
      if (size + 20 > b.length) bad("图片内容或格式无效");
      if (chunk === "VP8X" && size >= 10)
        return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === "VP8 " && size >= 10 && b.subarray(23, 26).equals(Buffer.from([157,1,42])))
        return { width: b.readUInt16LE(26) & 16383, height: b.readUInt16LE(28) & 16383 };
      if (chunk === "VP8L" && size >= 5 && b[20] === 47) {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
      }
    }
  } catch { bad("图片内容或格式无效"); }
  return bad("图片内容与声明格式不符");
}

function validateBytes(bytes: Buffer, contentType: ImageType) {
  if (!bytes.length || bytes.length > MAX_SAVED_IMAGE_BYTES) bad("保存后的图片不能超过180KB");
  const dims = imageDimensions(bytes, contentType);
  if (!dims.width || !dims.height || Math.max(dims.width, dims.height) > MAX_IMAGE_EDGE) bad("保存后的图片尺寸不能超过2048像素");
  return dims;
}

export function createCaptureAssetStore(dataDir: string) {
  // Directory descriptors anchor identity checks. Node's path-based calls are not openat/renameat:
  // they cannot isolate a process from another same-uid process with unrestricted filesystem writes.
  const sameIdentity=(a:{ino:bigint;dev:bigint},b:{ino:bigint;dev:bigint})=>a.ino===b.ino && a.dev===b.dev;
  const changed=():never=>{throw new NgError("conflict","图片目录或文件身份已变化，请核对后重试");};
  async function directory(create:boolean) {
    const parent=await realpath(dataDir), root=join(parent,"capture-assets");
    const parentHandle=await open(parent,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentIdentity=await parentHandle.stat({bigint:true});
    let handle:FileHandle | undefined;
    const assertParent=async()=> {
      const info=await lstat(parent,{bigint:true}).catch(()=>changed());
      if(!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info,parentIdentity) || await realpath(parent)!==parent) changed();
    };
    try {
      await assertParent();
      if(create) await mkdir(root,{mode:0o700}).catch(err=>{if((err as NodeJS.ErrnoException).code!=="EEXIST") throw err;});
      await assertParent();
      const info=await lstat(root,{bigint:true}).catch(err=>{if(absent(err)) return missing();throw err;});
      if(!info.isDirectory() || info.isSymbolicLink() || await realpath(root)!==root) changed();
      handle=await open(root,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const identity=await handle.stat({bigint:true});
      if(!identity.isDirectory() || !sameIdentity(info,identity)) changed();
      const assert=async()=> {
        await assertParent();
        const current=await lstat(root,{bigint:true}).catch(()=>changed());
        if(!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current,identity) || await realpath(root)!==root) changed();
      };
      await assert();
      const bound=handle;
      return {root,assert,async close(){try{await bound.close();}finally{await parentHandle.close();}}};
    } catch(err) {try{await handle?.close();}finally{await parentHandle.close();}throw err;}
  }
  async function read(id: string): Promise<CaptureImageData> {
    if (!/^[a-f0-9]{64}$/.test(id)) bad("图片标识无效");
    const guard = await directory(false);
    try {
      for (const [type, ext] of Object.entries(extensions) as Array<[ImageType, string]>) {
        const path = join(guard.root, `${id}.${ext}`);
        await guard.assert();
        const info = await lstat(path,{bigint:true}).catch(err => { if (absent(err)) return null; throw err; });
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink()) bad("图片文件无效");
        await guard.assert();
        // O_NOFOLLOW protects this final component; ancestor components are checked against directory identities.
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat({bigint:true});
          await guard.assert();
          if(!sameIdentity(info,stat)) changed();
          if (!stat.isFile() || stat.size > BigInt(MAX_SAVED_IMAGE_BYTES)) bad("保存后的图片不能超过180KB");
          const buffer = Buffer.alloc(MAX_SAVED_IMAGE_BYTES + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          const bytes = buffer.subarray(0, length), dims = validateBytes(bytes, type);
          if (hash(bytes) !== id) bad("图片内容已变化");
          await guard.assert();
          const still=await lstat(path,{bigint:true}).catch(()=>changed());
          if(!sameIdentity(stat,still) || still.isSymbolicLink()) changed();
          return { dataBase64: bytes.toString("base64"), contentType: type, bytes: length, ...dims };
        } finally { await file.close(); }
      }
      return missing();
    } finally {await guard.close();}
  }
  async function save(value: CaptureImageUpload, check: () => void = () => {}): Promise<SavedCaptureImage> {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(k => !["dataBase64", "contentType", "width", "height", "label"].includes(k))) bad("图片参数无效");
    if (!isImageType(value.contentType)) bad("支持PNG、JPEG、WebP和GIF图片");
    if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 160 || /[\\/\x00-\x1f]/.test(value.label)) bad("图片名称无效");
    const encoded = value.dataBase64;
    if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(MAX_SAVED_IMAGE_BYTES / 3) * 4 ||
        encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) bad("图片内容无效或过大");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) bad("图片内容无效");
    const dims = validateBytes(bytes, value.contentType);
    if (value.width !== dims.width || value.height !== dims.height) bad("图片尺寸与内容不符");
    const id=hash(bytes), guard=await directory(true);
    const target=join(guard.root,`${id}.${extensions[value.contentType]}`),temporary=join(guard.root,`.${randomUUID()}.tmp`);
    let file:FileHandle | undefined;
    let owned:{ino:bigint;dev:bigint} | undefined;
    const assertOwned=async(path:string)=> {
      await guard.assert();
      const info=await lstat(path,{bigint:true}).catch(()=>changed());
      if(!owned || !info.isFile() || info.isSymbolicLink() || !sameIdentity(owned,info)) changed();
    };
    try {
      check();await guard.assert();
      file=await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      owned=await file.stat({bigint:true});
      await assertOwned(temporary);
      await file.writeFile(bytes);await file.sync();
      check();await assertOwned(temporary);
      const published=await link(temporary,target).then(()=>true).catch(async err=> {
        if((err as NodeJS.ErrnoException).code!=="EEXIST") throw err;
        await guard.assert();await read(id);return false;
      });
      await guard.assert();
      if(published) await assertOwned(target);
      return {label:value.label,uri:CAPTURE_ASSET_PREFIX+id,contentType:value.contentType,bytes:bytes.length,...dims};
    } finally {
      try {
        await file?.close();
        if(owned) {
          // A renamed/replaced directory is deliberately left alone. Never unlink through a changed path.
          let ours=false;try{await assertOwned(temporary);ours=true;}catch{}
          if(ours) await unlink(temporary);
        }
      } finally {await guard.close();}
    }
  }

  return { save, read };
}
export type CaptureAssetStore = ReturnType<typeof createCaptureAssetStore>;
