import { createRoot } from "react-dom/client";
import { HumanInbox } from "../../src/web/views/HumanInbox";

import { RefreshProvider, useRefresh } from "../../src/web/state";

const submissions: Array<[number, number]> = [];
const saves: number[] = [];
let artifact = {artifactId:"draft", body:"初稿", version:1, versionText:"v1", format:"text",
  parked:[], decisions:[], save:{method:"PUT", path:"/api/artifacts/draft"}};
let revision = 1;
window.fetch = async (url, init) => {
  if (String(url).startsWith("/api/editor-leases/")) return Response.json({});
  if (url === artifact.save.path && init?.method === "PUT") {
    const {expectedVersion, body} = JSON.parse(String(init.body));
    saves.push(expectedVersion);
    await new Promise(resolve => setTimeout(resolve, 25));
    if (expectedVersion !== artifact.version) return Response.json({ok:false, outcome:"conflict", artifact}, {status:409});
    artifact = {...artifact, body, version:expectedVersion + 1, versionText:`v${expectedVersion + 1}`};
    return Response.json({ok:true, outcome:"saved", message:"已保存", artifact});
  }
  if (url === "/api/human-items") {
    return Response.json({
      items:
        submissions.length === 4
          ? []
          : [
              {id:"legacy", category:"decision", title:"另一件先到的事项", projects:[], actionRefs:[{cellId:"other",actionId:"legacy"}], options:[]},
              {
                id: "scope",
                category: "decision",
                title: "方案 v" + revision,
                itemRevision: revision,
                artifact,
                projects: [],
                actionRefs: [{cellId:"project",actionId:"legacy"}],
                options: [{ id: "reply", label: "回复", effect: "reply", input: { mode: "optional" } }],
              },
            ],
    });
  }
  if (url !== "/api/human-items/scope/decide") throw Error(String(url));
  const body = JSON.parse(String(init?.body));
  submissions.push([body.seenItemRevision, body.seenArtifactVersion]);
  if (submissions.length === 1) {
    revision++;
    return Response.json({ error: { code: "conflict", message: "item changed" } }, { status: 409 });
  }
  if (submissions.length === 2) return Response.json({error:{code:"bounds_violation", message:"owner only"}}, {status:409});
  if (submissions.length === 3) return Response.json({error:{code:"conflict", message:"待关闭的任务清单已变动"}}, {status:409});
  return Response.json({ status: "resolved" });
};

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(document.querySelector("article")?.innerText ?? "view did not load");
}
function Fixture() {
  const {bump} = useRefresh();
  return <><button id="background" onClick={() => {
    artifact = {...artifact, body:"后台新稿", version:3, versionText:"v3"};
    bump(["clarify"]);
  }}>后台改稿</button><HumanInbox actionRef={{cellId:"project",actionId:"legacy"}} /></>;
}
async function exercise() {
  createRoot(document.getElementById("root")!).render(<RefreshProvider><Fixture /></RefreshProvider>);
  await waitFor(() => document.querySelector("h1")?.textContent === "方案 v1");
  document.querySelector<HTMLButtonElement>(".inbox-paper button")!.click();
  await waitFor(() => !!document.querySelector("textarea"));
  const editor = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "修订稿");
  editor.dispatchEvent(new Event("input", {bubbles:true}));
  await waitFor(() => !!document.querySelector(".draft-actions button"));
  // A shortcut already handled elsewhere must not start a window-level save.
  const handled = new KeyboardEvent("keydown", {key:"s", ctrlKey:true, cancelable:true});
  handled.preventDefault();
  window.dispatchEvent(handled);
  if (saves.length) throw Error("window repeated a handled save");
  for (const modifier of [{ctrlKey:true}, {metaKey:true}])
    editor.dispatchEvent(new KeyboardEvent("keydown", {key:"s", ...modifier, bubbles:true, cancelable:true}));
  await waitFor(() => document.querySelector(".draft-version")?.textContent === "v2");
  document.querySelector<HTMLButtonElement>(".inbox-paper > button")!.click();
  await waitFor(() => !document.querySelector("textarea"));
  document.getElementById("background")!.click();
  await waitFor(() => document.querySelector(".draft-preview")?.textContent === "后台新稿");
  document.querySelector<HTMLButtonElement>(".inbox-choice button")!.click();
  await waitFor(() => !!document.querySelector("form"));
  document.querySelector("form")!.requestSubmit();
  await waitFor(() => document.body.innerText.includes("请先核对新版草稿"));
  if (submissions.length) throw Error("submitted an unreviewed background update");
  document.querySelector<HTMLButtonElement>(".banner button")!.click();
  await waitFor(() => !document.querySelector(".banner button"));
  document.querySelector("form")!.requestSubmit();
  await waitFor(() => document.querySelector("h1")?.textContent === "方案 v2");
  document.querySelector("form")!.requestSubmit();
  await waitFor(() => document.querySelector(".inbox-actions [role=alert]")?.textContent?.includes("此操作需要主人确认") === true);
  document.querySelector("form")!.requestSubmit();
  await waitFor(() => document.querySelector(".inbox-actions [role=alert]")?.textContent?.includes("待关闭的任务清单已变动") === true);
  document.querySelector("form")!.requestSubmit();
  await waitFor(() => document.body.innerText.includes("待办已清空"));
  return JSON.stringify({saves, submissions});
}
exercise().then(
  (result) => (document.getElementById("result")!.textContent = result),
  (err) => (document.getElementById("result")!.textContent = String(err)),
);
