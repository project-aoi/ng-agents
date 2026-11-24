import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/web/api";
import { MAX_SAVED_IMAGE_BYTES } from "../src/shared/capture-assets";
import { images } from "./fixtures/capture-images";

afterEach(()=>vi.unstubAllGlobals());
it("retains the entire 180 KiB response and detects missing bridge fields",async()=> {
  const bytes=Buffer.concat([Buffer.from(images[0]!.dataBase64,"base64"),Buffer.alloc(MAX_SAVED_IMAGE_BYTES-82)]);
  const response={dataBase64:bytes.toString("base64"),contentType:"image/png",width:16,height:16,bytes:bytes.length};
  vi.stubGlobal("fetch",async()=>Response.json(response));
  const blob=await api.readCaptureImage("/api/capture-assets/"+"a".repeat(64),new AbortController().signal);
  expect(blob.size).toBe(MAX_SAVED_IMAGE_BYTES);
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  vi.stubGlobal("fetch",async()=>Response.json({...response,dataBase64:undefined}));
  await expect(api.readCaptureImage("/api/capture-assets/"+"a".repeat(64),new AbortController().signal)).rejects.toThrow("Invalid image response");
});
it("validates image receipts and sends only one bounded request",async()=> {
  let calls=0;
  vi.stubGlobal("fetch",async(_path:string,init:RequestInit)=> {
    calls++;expect(Buffer.byteLength(String(init.body))).toBeLessThan(256*1024);
    return Response.json({label:images[0]!.label,uri:"/api/capture-assets/"+"b".repeat(64),contentType:"image/png",width:16,height:16,bytes:82});
  });
  const saved=await api.saveCaptureImage(images[0]!,new AbortController().signal);
  expect(saved.uri).toContain("b".repeat(64));expect(calls).toBe(1);
  vi.stubGlobal("fetch",async()=>Response.json({label:images[0]!.label,uri:saved.uri}));
  await expect(api.saveCaptureImage(images[0]!,new AbortController().signal)).rejects.toThrow("Incomplete image receipt");
});
