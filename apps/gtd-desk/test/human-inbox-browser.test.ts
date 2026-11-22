// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactDTO, HumanItemDTO } from "../src/shared/api";
import { useDeskEvents } from "../src/web/live";
import { RefreshProvider, StatusProvider, useRefresh } from "../src/web/state";
import { HumanInbox } from "../src/web/views/HumanInbox";

let root: Root;
let stream: EventTarget;
let requests: Array<{ path: string; method: string; body: Record<string, unknown> }>;
const setStatus = vi.fn();
class TestStream extends EventTarget {
  constructor() {
    super();
    stream = this;
  }
  close() {}
}
function ConnectedInbox({ cardId }: { cardId?: string | undefined }) {
  const { bump } = useRefresh();
  useDeskEvents({ refresh: bump, hello() {}, artifact() {}, notification() {}, cellTail() {} });
  return createElement(HumanInbox, { cardId });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", TestStream);
  requests = [];
  setStatus.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function artifact(version: number, body: string): ArtifactDTO {
  return {
    artifactId: "draft",
    body,
    version,
    versionText: `v${version}`,
    format: "text",
    updatedAt: 10,
    updatedBy: "agent",
    updatedByLabel: "分身",
    versions: [],
    parked: [],
    decisions: [],
    save: { method: "PUT", path: "/api/artifacts/draft" },
  };
}

function card(id: string, title: string, draft: ArtifactDTO | null = null): HumanItemDTO {
  return {
    id,
    title,
    subjectKey: id,
    category: "decision",
    status: "pending",
    cellId: "desk",
    epoch: 0,
    relatedProjectIds: [],
    itemRevision: 1,
    artifactId: draft?.artifactId ?? null,
    artifactVersion: draft?.version ?? null,
    artifact: draft,
    humanEdited: false,
    snoozedUntil: null,
    resumeTarget: null,
    projects: [],
    project: null,
    proposal: null,
    closeTargets: {},
    ownerOnly: false,
    action: null,
    options: [{ id: "reply", label: "回复", effect: "reply", input: { mode: "optional" } }],
  };
}
async function mount(
  readItems: () => HumanItemDTO[],
  write: (path: string, body: Record<string, unknown>) => Response,
  openIds: () => string[] = () => ["draft"],
  cardId?: string,
) {
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, method, body });
    if (path === "/api/human-items" && method === "GET") return Response.json({ items: readItems(), openArtifactIds: openIds() });
    return write(path, body);
  });
  await renderAt(cardId);
}

async function renderAt(cardId?: string) {
  const content = createElement(StatusProvider, { value: { status: null, setStatus } }, createElement(ConnectedInbox, { cardId }));
  await act(async () => root.render(createElement(RefreshProvider, null, content)));
}
function button(label: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!btn) throw Error(`没有显示按钮「${label}」`);
  return btn;
}
const click = (label: string) => act(async () => button(label).click());
const refresh = () =>
  act(async () => {
    stream.dispatchEvent(new MessageEvent("refresh", { data: JSON.stringify({ views: ["inbox"] }) }));
  });
async function typeText(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = (form: HTMLFormElement) =>
  act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
function beforeUnloadPrevented() {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}
const writes = () => requests.filter((x) => x.method !== "GET");

it("opens the linked card on first load and prevents confirming over a hidden unsaved plan", async () => {
  const proposal = {title: "原稿", outcome: "交付", actions: []};
  let visible = true;
  const plan = {...card("selected", "待审方案", artifact(1, JSON.stringify(proposal))), proposal,
    options:[{id:"system.execute",label:"确认立项",effect:"execute" as const}]};
  await mount(() => visible ? [card("first","另一件事"), plan] : [], () => { throw Error("unexpected write"); },
    () => visible ? ["draft"] : [], "selected");
  expect(document.querySelector("h1")?.textContent).toBe("待审方案");
  await click("展开专注编辑");
  await typeText(document.querySelector<HTMLInputElement>(".plan-editor input")!, "保留这个标题");
  await click("回到事项");
  await click("确认立项");
  expect(writes()).toEqual([]);
  expect(beforeUnloadPrevented()).toBe(true);
  await click("展开专注编辑");
  expect(document.querySelector<HTMLInputElement>(".plan-editor input")!.value).toBe("保留这个标题");
  await click("回到事项");
  visible = false;
  await refresh();
  expect(beforeUnloadPrevented()).toBe(false);
});

it("opens a linked decision outside the current filter and shows parked additions in its preview", async () => {
  const draft = artifact(1, "主人草稿");
  draft.parked.push({
    id: "parked", basedOnVersion: 1, format: "text", body: "后台补充的依据", createdAt: 10,
    dismiss: { id: "dismiss", label: "移除补充", primary: false, group: "main" },
  });
  const decision = card("decision", "审阅报告", draft);
  const action = { ...card("action", "整理资料"), category: "action" as const };
  await mount(() => [decision, action], () => { throw Error("浏览事项仅需读取"); });
  const filter = document.querySelector<HTMLSelectElement>('select[aria-label="筛选事项"]')!;
  await act(async () => {
    filter.value = "action";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector("h1")?.textContent).toBe("整理资料");
  await renderAt("decision");
  expect(filter.value).toBe("action");
  expect(document.querySelector("h1")?.textContent).toBe("审阅报告");
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.querySelector(".parked-body")?.textContent).toBe("后台补充的依据");
  expect(writes()).toEqual([]);
});

it("keeps the active card and text on stream updates, saves the typed text once and clears a finished card's draft", async () => {
  let current = card("reading", "核对资料", artifact(1, "原文"));
  let urgent: HumanItemDTO[] = [];
  let hidden = false;
  let closed = false;
  const status = { marker: "保存后" };
  const write = (path: string, body: Record<string, unknown>) => {
    expect(path).toBe("/api/artifacts/draft");
    const next = artifact(2, String(body.body));
    current = { ...current, artifact: next, artifactVersion: next.version };
    return Response.json({ ok: true, outcome: "saved", artifact: next, message: "已保存" });
  };
  await mount(
    () => (hidden ? urgent : [...urgent, current]),
    write,
    () => (closed ? [] : ["draft"]),
  );
  await click("展开专注编辑");
  const field = document.querySelector("textarea")!;
  await typeText(field, "我的第一份修订");
  expect(beforeUnloadPrevented()).toBe(true);
  urgent = [{ ...card("urgent", "先到期的新事项"), dueAt: 1 }];
  await refresh();
  expect(document.querySelector("h1")?.textContent).toBe("核对资料");
  expect(field.value).toBe("我的第一份修订");

  await act(async () => {
    const handled = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
  });
  expect(writes()).toHaveLength(0);
  await act(async () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ...modifier, bubbles: true, cancelable: true }));
    }
  });
  expect(writes().map((r) => r.body)).toEqual([{ expectedVersion: 1, body: "我的第一份修订" }]);
  expect(beforeUnloadPrevented()).toBe(false);

  await typeText(field, "仅用于本事项的草稿");
  expect(beforeUnloadPrevented()).toBe(true);
  hidden = true;
  await refresh();
  expect(document.querySelector("h1")?.textContent).toBe("先到期的新事项");
  expect(beforeUnloadPrevented()).toBe(true);
  closed = true;
  await refresh();
  expect(beforeUnloadPrevented()).toBe(false);
});

it("requires review after the open decision changes and sends only the reviewed versions with its owner's note", async () => {
  let current = card("reading", "核对资料", artifact(1, "原文"));
  const other = { ...card("urgent", "新事项"), dueAt: 1 };
  let items = [current];
  let attempts = 0;
  await mount(
    () => items,
    () => {
      if (++attempts === 1) {
        current = { ...current, itemRevision: 3, title: "再次修改的事项" };
        items = [other, current];
        return Response.json({ error: { code: "conflict", message: "事项已变动" } }, { status: 409 });
      }
      if (attempts === 2) return Response.json({ error: { code: "bounds_violation", message: "仅主人可确认" } }, { status: 403 });
      if (attempts === 3) return Response.json({ error: { code: "conflict", message: "待关闭的任务清单已变动" } }, { status: 409 });
      items = [other];
      return Response.json({ status: "resolved", deskStatus: { marker: "完成" } });
    },
  );
  await click("回复");
  const form = document.querySelector("form")!;
  const field = form.querySelector<HTMLInputElement>('input[aria-label="备注"]')!;
  await typeText(field, "我核对过了");
  current = { ...current, title: "修改后的事项", itemRevision: 2, artifact: artifact(2, "更新的资料"), artifactVersion: 2 };
  items = [other, current];
  await refresh();
  expect(document.querySelector("h1")?.textContent).toBe("修改后的事项");
  expect(field.value).toBe("我核对过了");
  await submit(form);
  expect(writes()).toEqual([]);
  await click("已核对最新事项");
  await submit(form);
  expect(writes()).toEqual([]);
  await click("已核对新版");
  await submit(form);
  expect(writes().map((x) => x.body)).toEqual([
    { optionId: "reply", note: "我核对过了", seenItemRevision: 2, seenArtifactVersion: 2 },
  ]);
  await submit(form);
  expect(writes()).toHaveLength(1);
  await click("已核对最新事项");
  await submit(form);
  expect(document.querySelector(".inbox-actions [role=alert]")?.textContent).toMatch(/主人/);
  await submit(form);
  expect(document.querySelector(".inbox-actions [role=alert]")?.textContent).toContain("待关闭的任务清单已变动");
  await submit(form);
  expect(writes().map((r) => r.body.seenItemRevision)).toEqual([2, 3, 3, 3]);
  expect(setStatus).toHaveBeenCalledWith({ marker: "完成" });
});

it("accepts a locally saved plan immediately using the version that the server committed", async () => {
  const first = {title:"初稿", outcome:"交付报告", actions:[]};
  let plan: HumanItemDTO = {...card("own-plan", "立项", artifact(1, JSON.stringify(first))), proposal:first,
    options:[{id:"system.execute", label:"确认立项", effect:"execute"}]};
  const decisions: Record<string, unknown>[] = [];
  await mount(() => [plan], (path, body) => {
    if (path.endsWith("/plan")) {
      const proposal = {...first, title: "保存后的标题"};
      expect(body.proposal).toMatchObject(proposal);
      const saved = artifact(2, JSON.stringify(proposal));
      plan = {...plan, proposal, artifact:saved, artifactVersion:2};
      return Response.json({ok:true, outcome:"saved", message:"已保存", artifact:saved, deskStatus:{}});
    }
    decisions.push(body);
    return Response.json({status:"approved", deskStatus:{}});
  });
  await click("展开专注编辑");
  const form = document.querySelector<HTMLFormElement>(".plan-editor")!;
  await typeText(form.querySelector("input")!, "保存后的标题");
  await submit(form);
  expect(document.querySelector(".plan-editor")).toBeNull();
  expect(document.body.textContent).not.toContain("请核对后再确认");
  await click("确认立项");
  expect(decisions).toEqual([expect.objectContaining({optionId:"system.execute", seenItemRevision:1, seenArtifactVersion:2})]);
});

it("keeps the edited plan after a remote removal and an input method's Escape", async () => {
  const proposal = {title: "原方案", outcome: "交付", actions: []};
  const plan = {...card("removed-plan", "立项", artifact(1, JSON.stringify(proposal))), proposal};
  let items: HumanItemDTO[] = [plan];
  await mount(() => items, () => Response.json({error:{code:"conflict", message:"事项已变动"}}, {status:409}));
  await click("展开专注编辑");
  const form = document.querySelector<HTMLFormElement>(".plan-editor")!;
  const title = form.querySelector("input")!;
  await typeText(title, "尚未保存的标题");
  await act(async () => {
    const escape = new KeyboardEvent("keydown", {key:"Escape", bubbles:true});
    Object.defineProperty(escape, "isComposing", {value:true});
    title.dispatchEvent(escape);
  });
  expect(document.querySelector(".plan-editor")).toBe(form);
  items = [];
  await refresh();
  await submit(form);
  expect(document.querySelector(".plan-editor input")).toBe(title);
  expect(title.value).toBe("尚未保存的标题");
  expect(beforeUnloadPrevented()).toBe(true);
  await click("取消");
  expect(beforeUnloadPrevented()).toBe(false);
});

it("compares the reloaded plan after HTTP 409 and keeps that baseline when a retry fails", async () => {
  const first = { title: "初版方案", outcome: "初版目标", actions: [] };
  let current = { ...card("plan", "方案", artifact(1, JSON.stringify(first))), proposal: first };
  let attempts = 0;
  await mount(
    () => [current],
    (_path, body) => {
      expect((body.proposal as { title: string }).title).toBe("我的标题");
      if (++attempts === 1) {
        const remote = { title: "线上第三版", outcome: "第三版目标", actions: [] };
        current = { ...current, proposal: remote, artifact: artifact(3, JSON.stringify(remote)), artifactVersion: 3 };
        return Response.json(
          { ok: false, outcome: "conflict", message: "有新版本", current: artifact(2, "另一个版本") },
          { status: 409 },
        );
      }
      if (attempts === 2) return Response.json({ error: { code: "busy", message: "稍后重试" } }, { status: 503 });
      return Response.json({ ok: true, outcome: "saved", artifact: artifact(4, JSON.stringify(current.proposal)), message: "已保存方案", deskStatus: { marker: "已保存方案" } });
    },
  );
  await click("展开专注编辑");
  const form = document.querySelector<HTMLFormElement>(".plan-editor")!;
  const title = form.querySelector("input")!;
  expect(beforeUnloadPrevented()).toBe(false);
  await typeText(title, "我的标题");
  expect(beforeUnloadPrevented()).toBe(true);
  await submit(form);
  const comparison = () => document.querySelector(".theirs-plan")?.textContent;
  expect(comparison()).toContain("第三版目标");
  expect(comparison()).not.toContain("初版目标");
  expect(title.value).toBe("我的标题");
  await click("按我的修改保存为 v4");
  expect(comparison()).toContain("第三版目标");
  expect(form.textContent).toContain("稍后重试");
  expect(title.value).toBe("我的标题");
  expect(beforeUnloadPrevented()).toBe(true);
  await click("按我的修改保存为 v4");
  expect(writes().map((r) => r.body.expectedVersion)).toEqual([1, 3, 3]);
  expect(setStatus).toHaveBeenCalledWith({ marker: "已保存方案" });
  expect(beforeUnloadPrevented()).toBe(false);
});
