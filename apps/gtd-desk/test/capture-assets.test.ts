import { renameSync, symlinkSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { get } from "@ng/protocol";
import type { CaptureResponse } from "../src/shared/api";
import { createCaptureAssetStore } from "../src/server/capture-assets";
import { captureAssetId, MAX_SAVED_IMAGE_BYTES, type SavedCaptureImage, type CaptureImageData } from "../src/shared/capture-assets";
import { bootDesk, bootRealDesk, cleanupAll, tempDir, tool } from "./helpers";
import { images } from "./fixtures/capture-images";

afterEach(cleanupAll);
for (const image of images) it(`roundtrips a real ${image.contentType} and reuses its private object`, async () => {
  const root = tempDir("images"), store = createCaptureAssetStore(root);
  const first = await store.save(image), second = await store.save({...image,label:"another-name"});
  expect(second.uri).toBe(first.uri);
  const read = await createCaptureAssetStore(root).read(captureAssetId(first.uri)!);
  expect(read).toMatchObject({dataBase64:image.dataBase64, contentType:image.contentType, width:image.width,height:image.height});
  const files = await readdir(join(root,"capture-assets"));
  expect(files).toHaveLength(1);
  expect((await lstat(join(root,"capture-assets",files[0]!))).mode & 0o777).toBe(0o600);
  expect((await readFile(join(root,"capture-assets",files[0]!))).toString("base64")).toBe(image.dataBase64);
});

it("rejects spoofing, unknown input, invalid base64 and oversized saved images", async () => {
  const store=createCaptureAssetStore(tempDir("rejected")), image=images[0]!;
  for (const value of [{...image,contentType:"image/jpeg"},{...image,contentType:"image/svg+xml"},{...image,width:999},
    {...image,dataBase64:"AAAA===="},{...image,dataBase64:""},{...image,extra:"hidden"},
    {...image,dataBase64:Buffer.alloc(MAX_SAVED_IMAGE_BYTES+1).toString("base64")}])
    await expect(store.save(value as typeof image)).rejects.toThrow();
});

it("accepts exactly 180 KiB, rejects the next byte, and cleans failed publication", async () => {
  const root=tempDir("boundary"), store=createCaptureAssetStore(root), image=images[0]!;
  const bytes=Buffer.concat([Buffer.from(image.dataBase64,"base64"),Buffer.alloc(MAX_SAVED_IMAGE_BYTES-Buffer.from(image.dataBase64,"base64").length)]);
  await store.save({...image,dataBase64:bytes.toString("base64")});
  await expect(store.save({...image,dataBase64:Buffer.concat([bytes,Buffer.from([0])]).toString("base64")})).rejects.toThrow();
  let checks=0;
  await expect(store.save(images[1]!,()=>{if(++checks===2) throw Error("expired");})).rejects.toThrow("expired");
  expect((await readdir(join(root,"capture-assets"))).filter(f=>f.endsWith("tmp"))).toEqual([]);
});

it("rejects traversal, symlink roots/files and changed file contents",async()=> {
  const root=tempDir("paths"),store=createCaptureAssetStore(root), saved=await store.save(images[0]!),id=captureAssetId(saved.uri)!;
  for (const bad of ["../private",id+".png","%2e%2e",id.toUpperCase(),"a".repeat(65)]) await expect(store.read(bad)).rejects.toThrow();
  const target=join(root,"capture-assets",id+".png");
  await writeFile(target,Buffer.from(images[1]!.dataBase64,"base64"));
  await expect(store.read(id)).rejects.toThrow();
  const other=tempDir("symlink");await symlink(root,join(other,"capture-assets"));
  await expect(createCaptureAssetStore(other).save(images[0]!)).rejects.toThrow();
  const linkRoot=tempDir("leaf"),linkStore=createCaptureAssetStore(linkRoot);
  const another=await linkStore.save(images[1]!);
  await symlink(target,join(linkRoot,"capture-assets",id+".png"));
  await expect(linkStore.read(id)).rejects.toThrow();
  expect(another.uri).not.toBe(saved.uri);
});

it("accepts token-free local requests and rejects foreign Host/Origin and illegal image IDs",async()=> {
  const d=await bootDesk();
  const response=await d.server.app.request("/api/capture-assets",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(images[0])});
  expect(response.status).toBe(200);
  const saved=await response.json() as SavedCaptureImage;
  expect((await d.req("GET",saved.uri)).status).toBe(200);
  expect((await d.req("GET",saved.uri,undefined,{host:"foreign.test"})).status).toBe(403);
  expect((await d.req("GET","/api/capture-assets/nope")).status).toBe(400);
  expect((await d.req("POST","/api/capture-assets",images[0],{origin:"https://foreign.test"})).status).toBe(403);
});

it("captures only a short URI, keeps text/link/idempotency, and projects persistent attachments",async()=> {
  const d=await bootDesk();
  const saved=await d.post<SavedCaptureImage>("/api/capture-assets",images[0]);
  const attachments=[{label:saved.label,uri:saved.uri},{label:"reference",uri:"https://example.com"}];
  const request={text:"",clientId:"picture-once",attachments};
  const captured=await d.post<CaptureResponse>("/api/capture",request);await d.post("/api/capture",request);await d.kernel.idle();
  const messages=d.kernel.inbox.listMessagesSync({cellId:"desk",envelopeId:captured.id});
  expect(messages).toHaveLength(1);
  expect(messages[0]!.envelope.payload).toMatchObject({text:"",attachments});
  expect(JSON.stringify(messages[0]!.envelope)).not.toContain("dataBase64");
  expect(JSON.stringify(messages[0]!.envelope)).not.toContain("capture-fixtures");
  d.kernel.humanItems.create({title:"image",subjectKey:"image",source:{label:"随手记",at:d.clock.now(),envelopeId:captured.id},options:[{id:"ack",label:"ack",effect:"reply"}]},"desk");
  const list=await d.get<{items:Array<{attachments:unknown}>}>("/api/human-items");
  expect(list.items[0]!.attachments).toEqual(attachments);
  const plan=get<{detail:string}>(d.kernel.db,"EXPLAIN QUERY PLAN SELECT * FROM inbox_messages WHERE cell_id=? AND envelope_id=? ORDER BY seq LIMIT 1",["desk",captured.id]);
  expect(plan?.detail).toContain("INDEX");
  const timeline=d.server.desk.timeline("desk",{});
  expect(timeline.items.find(i=>i.kind==="user_chat" && i.id===captured.id)).toMatchObject({attachments});
  const read=await d.get<CaptureImageData>(saved.uri);
  expect(read.dataBase64).toBe(images[0]!.dataBase64);
  expect((await d.req("POST","/api/capture",{text:"",attachments:Array(6).fill(attachments[0])})).status).toBe(400);
  expect((await d.req("POST","/api/capture",{text:"",attachments:[{label:"raw",uri:"data:image/png;base64,AAAA"}]})).status).toBe(400);
  await d.post("/api/capture",{text:"plain",clientId:"plain"});
  await d.post("/api/capture",{text:"",attachments:[{label:"link",uri:"https://example.com"}]});
  expect((await d.req("POST","/api/capture",{text:" "})).status).toBe(400);
});

it("a saved note does not create a card just to display its image",async()=> {
  const d=await bootRealDesk();d.script.add("desk",tool("capture_note",{title:"图片资料"}));
  const saved=await d.post<SavedCaptureImage>("/api/capture-assets",images[0]);
  const captured=await d.post<CaptureResponse>("/api/capture",{text:"存一下",clientId:"note-image",attachments:[{label:saved.label,uri:saved.uri}]});
  await d.kernel.idle();
  expect(d.server.desk.listHumanItems()).toEqual([]);
  expect(d.server.desk.timeline("desk",{}).items.find(i=>i.kind==="user_chat" && i.id===captured.id)).toMatchObject({attachments:[{uri:saved.uri}]});
});


it("rejects reusing a persisted clientId for changed text or attachments",async()=> {
  const d=await bootDesk();
  const before=await d.post<SavedCaptureImage>("/api/capture-assets",{...images[0]!,label:"before.png"});
  const after=await d.post<SavedCaptureImage>("/api/capture-assets",{...images[1]!,label:"after.png"});
  const original={text:"before",clientId:"identity",attachments:[{label:before.label,uri:before.uri}]};
  const first=await d.post<CaptureResponse>("/api/capture",original);
  const retry=await d.post<CaptureResponse>("/api/capture",original);
  expect(retry.id).toBe(first.id);expect(retry.acceptedAt).toBe(first.acceptedAt);
  const changed={...original,text:"after",attachments:[{label:after.label,uri:after.uri}]};
  const rejected=await d.req<{error:{code:string}}>("POST","/api/capture",changed);
  expect(rejected.status).toBe(409);expect(rejected.json.error.code).toBe("capture_conflict");
  await d.kernel.idle();
  const records=d.kernel.inbox.listMessagesSync({cellId:"desk",envelopeId:first.id});
  expect(records).toHaveLength(1);expect(records[0]!.envelope.payload).toMatchObject({text:"before",attachments:original.attachments});
  const created=await d.post<CaptureResponse>("/api/capture",{...changed,clientId:"identity-edited"});
  await d.kernel.idle();
  expect(created.id).not.toBe(first.id);
  expect(d.server.desk.timeline("desk",{}).items.filter(i=>i.kind==="user_chat").map(i=>({text:i.text,attachments:i.attachments})))
    .toEqual(expect.arrayContaining([{text:"before",attachments:original.attachments},{text:"after",attachments:changed.attachments}]));
});

it("a concurrent different payload cannot be acknowledged under the same identity",async()=> {
  const d=await bootDesk(),saved=await d.post<SavedCaptureImage>("/api/capture-assets",images[0]);
  const base={clientId:"simultaneous",attachments:[{label:saved.label,uri:saved.uri}]};
  const result=await Promise.all([d.req("POST","/api/capture",{...base,text:"one"}),d.req("POST","/api/capture",{...base,text:"two"})]);
  expect(result.map(r=>r.status).sort()).toEqual([200,409]);
  expect(d.kernel.inbox.listMessagesSync({cellId:"desk",envelopeId:"ui:simultaneous"})).toHaveLength(1);
});

for(const when of [1,2]) it(`rejects a root symlink replacement before operation check ${when}`,async()=> {
  const root=tempDir("root-swap"),outside=tempDir("outside-swap"),store=createCaptureAssetStore(root);
  await store.save(images[0]!);let checks=0;
  await expect(store.save(images[1]!,()=> {
    if(++checks===when) {renameSync(join(root,"capture-assets"),join(root,"original-assets"));symlinkSync(outside,join(root,"capture-assets"));}
  })).rejects.toThrow("身份已变化");
  expect(await readdir(outside)).toEqual([]);
});

it("rejects an ordinary directory replacement and preserves a foreign temporary file",async()=> {
  const root=tempDir("dir-swap"),store=createCaptureAssetStore(root);await store.save(images[0]!);
  await expect(store.save(images[1]!,()=> {
    renameSync(join(root,"capture-assets"),join(root,"old-assets"));mkdirSync(join(root,"capture-assets"));
  })).rejects.toThrow("身份已变化");
  expect(await readdir(join(root,"capture-assets"))).toEqual([]);
  const other=tempDir("temp-swap"),otherStore=createCaptureAssetStore(other);let checks=0,foreign="";
  await expect(otherStore.save(images[0]!,()=> {
    if(++checks===2) {foreign=join(other,"capture-assets",readdirSync(join(other,"capture-assets")).find(n=>n.endsWith(".tmp"))!);unlinkSync(foreign);writeFileSync(foreign,"foreign");}
  })).rejects.toThrow("身份已变化");
  expect(await readFile(foreign,"utf8")).toBe("foreign");
});
