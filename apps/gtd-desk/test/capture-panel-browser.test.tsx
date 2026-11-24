// @vitest-environment happy-dom
import { URL as NodeURL } from "node:url";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CapturePanel } from "../src/web/components/drawer";
import { CaptureAttachments, prepareImage } from "../src/web/components/capture-images";
import { api } from "../src/web/api";
import { images } from "./fixtures/capture-images";

let root:Root, host:HTMLDivElement, sequence=0, canvasCalls=0;
let canvasResult: Blob;
const revoke=vi.fn();
const saved={label:"one.png",uri:"/api/capture-assets/"+"a".repeat(64),contentType:"image/png" as const,width:16,height:16,bytes:82};
function inputFile(name="one.png") {return new File([Uint8Array.from(atob(images[0]!.dataBase64),c=>c.charCodeAt(0))],name,{type:"image/png"});}
async function drain() {await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
function buttons(text:string) {return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter(b=>b.textContent===text);}
async function paste(files:File[],text="") {
  const event=new Event("paste",{bubbles:true,cancelable:true});
  Object.defineProperty(event,"clipboardData",{value:{items:files.map(file=>({kind:"file",type:file.type,getAsFile:()=>file})),getData:()=>text}});
  await act(async()=>{host.querySelector("textarea")!.dispatchEvent(event);await new Promise(r=>setTimeout(r,0));});
}
beforeEach(async()=> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true); document.documentElement.lang="zh-CN";
  vi.stubGlobal("IntersectionObserver",undefined);
  vi.spyOn(document,"hidden","get").mockReturnValue(false);
  canvasCalls=0;canvasResult=inputFile();
  host=document.createElement("div");document.body.append(host);root=createRoot(host);revoke.mockClear();
  vi.stubGlobal("URL",class extends NodeURL {static override createObjectURL(){return "blob:test-"+(++sequence);}static override revokeObjectURL=revoke;});
  vi.stubGlobal("Image",class { naturalWidth=16;naturalHeight=16;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;set src(v:string){if(v)queueMicrotask(()=>this.onload?.());} });
  const original=document.createElement.bind(document);
  vi.spyOn(document,"createElement").mockImplementation(((tag:string,opts?:ElementCreationOptions)=> {
    const element=original(tag,opts);
    if(tag==="canvas") {
      Object.defineProperty(element,"getContext",{value:()=>({drawImage(){}})});
      Object.defineProperty(element,"toBlob",{value:(callback:(blob:Blob)=>void)=>{canvasCalls++;callback(canvasResult);}});
    }
    return element;
  }) as typeof document.createElement);
  vi.spyOn(api,"saveCaptureImage").mockResolvedValue(saved);
  vi.spyOn(api,"readCaptureImage").mockResolvedValue(inputFile());
  vi.spyOn(api,"capture").mockResolvedValue({ok:true,id:"captured",acceptedAt:1,message:"已收进信箱",status:{} as never});
});
afterEach(async()=> {await act(()=>root.unmount());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});

it("preserves mixed paste text and links, uploads once, and reuses clientId/URI after capture failure",async()=> {
  await act(()=>root.render(createElement(CapturePanel)));
  await paste([inputFile()],"pasted words");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("pasted words");
  const input=host.querySelector<HTMLInputElement>("input")!;
  await act(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;setter.call(input,"https://example.com");input.dispatchEvent(new Event("input",{bubbles:true}));});
  vi.mocked(api.capture).mockRejectedValueOnce(Error("failed"));
  await act(async()=>{buttons("收进信箱")[0]!.click();await new Promise(r=>setTimeout(r,0));});
  expect(host.querySelector("textarea")!.value).toBe("pasted words");
  await act(async()=>{buttons("收进信箱")[0]!.click();await new Promise(r=>setTimeout(r,0));});
  const requests=vi.mocked(api.capture).mock.calls;
  expect(requests[1]![0].clientId).toBe(requests[0]![0].clientId);
  expect(requests[1]![0].attachments).toEqual([{label:saved.label,uri:saved.uri},{label:"https://example.com",uri:"https://example.com"}]);
  expect(api.saveCaptureImage).toHaveBeenCalledTimes(1);
  expect(host.querySelector("textarea")!.value).toBe("");expect(host.querySelector("input")!.value).toBe("");
});

it("never resurrects an image removed while its upload receipt is pending",async()=> {
  let finish!:(v:typeof saved)=>void;
  vi.mocked(api.saveCaptureImage).mockImplementation(()=>new Promise(r=>{finish=r;}));
  await act(()=>root.render(createElement(CapturePanel)));await paste([inputFile()]);
  await act(()=>buttons("移除")[0]!.click());
  await act(async()=>{finish(saved);await new Promise(r=>setTimeout(r,0));});
  expect(host.querySelectorAll(".capture-image")).toHaveLength(0);
  expect(buttons("收进信箱")[0]!.disabled).toBe(true);
  expect(revoke).toHaveBeenCalled();
});

it("caps at five, allows image-only capture and explicit upload retry",async()=> {
  vi.mocked(api.saveCaptureImage).mockRejectedValueOnce(Error("failed"));
  await act(()=>root.render(createElement(CapturePanel)));await paste([inputFile()]);
  expect(buttons("收进信箱")[0]!.disabled).toBe(true);
  await act(async()=>{buttons("重试")[0]!.click();await new Promise(r=>setTimeout(r,0));});
  expect(buttons("收进信箱")[0]!.disabled).toBe(false);
  await paste(Array.from({length:5},(_,n)=>inputFile("file"+n)));await drain();
  expect(host.querySelectorAll(".capture-image-actions")).toHaveLength(5);
  expect(host.textContent).toContain("每条随手记最多5张图片");
});

it("shows English input and conversion limits, and rejects oversized input before decoding",async()=> {
  document.documentElement.lang="en-US";
  await act(()=>root.render(createElement(CapturePanel)));
  expect(host.textContent).toContain("GIF animation is not preserved");expect(buttons("Save note")).toHaveLength(1);
  await expect(prepareImage(new File([new Uint8Array(10*1024*1024+1)],"large.png",{type:"image/png"}),"large",new AbortController().signal)).rejects.toThrow("10 MB");
  await expect(prepareImage(new File(["svg"],"unsafe.svg",{type:"image/svg+xml"}),"unsafe",new AbortController().signal)).rejects.toThrow("PNG");
});

it("reads an attachment after mounting again and releases its object URL",async()=> {
  const items=[{label:saved.label,uri:saved.uri}];
  await act(async()=>{root.render(createElement(CaptureAttachments,{items}));await new Promise(r=>setTimeout(r,0));});
  expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
  await act(()=>root.render(null));expect(revoke).toHaveBeenCalled();
  await act(async()=>{root.render(createElement(CaptureAttachments,{items}));await new Promise(r=>setTimeout(r,0));});
  expect(api.readCaptureImage).toHaveBeenCalledTimes(2);
});

it("defers hidden-tab loading, preserves loaded previews and open viewer across tab switches, and renders duplicate URIs cleanly",async()=> {
  let hidden=true;
  vi.spyOn(document,"hidden","get").mockImplementation(()=>hidden);
  const errorSpy=vi.spyOn(console,"error").mockImplementation(()=>{});
  const items=[{label:"a.png",uri:saved.uri},{label:"b.png",uri:saved.uri}];
  await act(async()=>{root.render(createElement(CaptureAttachments,{items}));await new Promise(r=>setTimeout(r,0));});
  expect(api.readCaptureImage).toHaveBeenCalledTimes(0);
  hidden=false;
  await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));await new Promise(r=>setTimeout(r,0));});
  expect(api.readCaptureImage).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll(".capture-image img")).toHaveLength(2);
  const trigger=host.querySelector<HTMLButtonElement>(".capture-image-open")!;
  await act(()=>trigger.click());
  expect(host.querySelector("dialog")).not.toBeNull();
  revoke.mockClear();
  hidden=true;
  await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));await new Promise(r=>setTimeout(r,0));});
  hidden=false;
  await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));await new Promise(r=>setTimeout(r,0));});
  expect(api.readCaptureImage).toHaveBeenCalledTimes(2);
  expect(revoke).not.toHaveBeenCalled();
  expect(host.querySelector("dialog")).not.toBeNull();
  expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("same key");
});

it("bounds canvas conversion at eight attempts and reports failure",async()=> {
  canvasResult=new Blob([new Uint8Array(180*1024+1)],{type:"image/webp"});
  await expect(prepareImage(inputFile(),"large",new AbortController().signal)).rejects.toThrow("180KB");
  expect(canvasCalls).toBe(8);
});

it("closes only the image viewer on Escape and restores its trigger focus",async()=> {
  await act(async()=>{root.render(createElement(CaptureAttachments,{items:[{label:saved.label,uri:saved.uri}]}));await new Promise(r=>setTimeout(r,0));});
  const trigger=host.querySelector<HTMLButtonElement>(".capture-image-open")!;
  await act(()=>trigger.click());
  expect(host.querySelector("dialog")).not.toBeNull();
  let escaped=false;host.addEventListener("keydown",()=>{escaped=true;});
  await act(()=>host.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(host.querySelector("dialog")).toBeNull();expect(document.activeElement).toBe(trigger);expect(escaped).toBe(false);
});

it("preserves actual backend content when the first accepted response is lost and the draft changes",async()=> {
  // Start the server in Node, where import.meta.url and the unmodified runtime version logic have file URLs.
  let ngRoot=resolve(process.cwd());
  for(let depth=0;depth<4 && !existsSync(join(ngRoot,"apps/gtd-desk/test/fixtures/capture-backend.ts"));depth++) ngRoot=dirname(ngRoot);
  const child=fork(join(ngRoot,"apps/gtd-desk/test/fixtures/capture-backend.ts"),[],{cwd:ngRoot,
    execArgv:["--import",join(ngRoot,"node_modules/tsx/dist/loader.mjs")],silent:true});
  let errors="";child.stderr?.on("data",chunk=>{errors+=String(chunk);});
  const next=<T,>()=>new Promise<T>((resolveMessage,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error(`Node capture backend timed out: ${errors}`));},5000);
    const message=(value:T)=>{cleanup();resolveMessage(value);};
    const exit=(code:number|null)=>{cleanup();reject(Error(`Node capture backend exited ${code}: ${errors}`));};
    const cleanup=()=>{clearTimeout(timer);child.off("message",message);child.off("exit",exit);};
    child.once("message",message);child.once("exit",exit);
  });
  const records=async()=> {const pending=next<{records:Array<{text:string;attachments:unknown}>}>();child.send({id:1,kind:"records"});return (await pending).records;};
  const settled=async(check:()=>void)=>act(async()=>{
    await vi.waitFor(check,{timeout:5000,interval:20});
    await new Promise(resolveTick=>setTimeout(resolveTick,0));
  });
  try {
  const backend=await next<{url:string}>();
  const send=(path:string,init:RequestInit)=>new Promise<{status:number;json:unknown}>((resolveResponse,reject)=>{
    const req=request(new NodeURL(path,backend.url),{method:init.method ?? "GET",headers:{"content-type":"application/json"}},response=>{
      const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(Buffer.from(chunk)));
      response.on("end",()=>{try{resolveResponse({status:response.statusCode!,json:JSON.parse(Buffer.concat(chunks).toString())});}catch(error){reject(error);}});
      response.on("error",reject);
    });
    req.setTimeout(5000,()=>req.destroy(Error("Capture request timed out")));req.on("error",reject);
    if(init.body) req.write(String(init.body));req.end();
  });
  vi.mocked(api.saveCaptureImage).mockRestore();vi.mocked(api.capture).mockRestore();vi.mocked(api.readCaptureImage).mockRestore();
  const requests:Array<{text:string;clientId:string;attachments:Array<{label:string;uri:string}>}>=[];
  let uploads=0, completedCaptures=0;
  vi.stubGlobal("fetch",async(path:string,init:RequestInit)=> {
    const payload=init.body ? JSON.parse(String(init.body)) : undefined;
    const r=await send(path,init);
    if(path==="/api/capture-assets" && init.method==="POST") uploads++;
    if(path==="/api/capture") {
      requests.push(payload);
      if(requests.length===1) {
        expect(r.status).toBe(200);
        expect(await records()).toHaveLength(1);
        completedCaptures++;
        return Response.json({error:{code:"lost",message:"Lost response after persistence"}},{status:503});
      }
      completedCaptures++;
    }
    return Response.json(r.json,{status:r.status});
  });
  await act(()=>root.render(createElement(CapturePanel)));await paste([inputFile("before.png")],"before text");
  await settled(()=>expect(uploads).toBe(1));
  expect(buttons("收进信箱")[0]!.disabled).toBe(false);
  await act(()=>buttons("收进信箱")[0]!.click());
  await settled(()=>expect(completedCaptures).toBe(1));
  expect(requests).toHaveLength(1);expect(host.textContent).toContain("可能已收进信箱");
  await act(()=>buttons("移除")[0]!.click());
  canvasResult=new Blob([Uint8Array.from(atob(images[1]!.dataBase64),c=>c.charCodeAt(0))],{type:"image/jpeg"});
  await paste([inputFile("after.png")]);
  await act(()=> {const textarea=host.querySelector<HTMLTextAreaElement>("textarea")!;const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;setter.call(textarea,"after text");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
  await settled(()=>expect(uploads).toBe(2));
  expect(buttons("提交修改后的随手记")[0]!.disabled).toBe(false);
  await act(()=>buttons("提交修改后的随手记")[0]!.click());
  await settled(()=>expect(completedCaptures).toBe(2));
  expect(requests).toHaveLength(2);expect(requests[1]!.clientId).not.toBe(requests[0]!.clientId);
  expect(host.querySelector("textarea")!.value).toBe("");
  await act(()=>root.render(null));
  const persisted=await records();
  expect(persisted).toHaveLength(2);
  expect(persisted).toEqual(expect.arrayContaining([
    expect.objectContaining({text:"before text",attachments:[{label:"before.png",uri:requests[0]!.attachments[0]!.uri}]}),
    expect.objectContaining({text:"after text",attachments:[{label:"after.png",uri:requests[1]!.attachments[0]!.uri}]}),
  ]));
  } finally {
    await act(()=>root.render(null));
    if(child.exitCode===null) await new Promise<void>(resolveExit=>{
      const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
      child.once("exit",()=>{clearTimeout(timer);resolveExit();});child.kill("SIGTERM");
    });
  }
},15000);

it("restores the actual trigger after the modal DOM is removed",async()=> {
  const external=document.createElement("input");document.body.append(external);external.focus();
  await act(async()=>{root.render(createElement(CaptureAttachments,{items:[{label:saved.label,uri:saved.uri}]}));await new Promise(r=>setTimeout(r,0));});
  const trigger=host.querySelector<HTMLButtonElement>(".capture-image-open")!;
  await act(()=>trigger.click());
  const focus=trigger.focus.bind(trigger);
  const spy=vi.spyOn(trigger,"focus").mockImplementation(()=>{expect(host.querySelector("dialog")).toBeNull();focus();});
  await act(()=>host.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(spy).toHaveBeenCalled();expect(document.activeElement).toBe(trigger);
});
