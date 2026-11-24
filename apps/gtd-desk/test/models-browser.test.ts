// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelsDTO, StatusDTO } from "../src/shared/api";
import { ModelSwitch } from "../src/web/components/models";
import { RefreshProvider } from "../src/web/state";

let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const STATUS: StatusDTO = {
  humanPending: 0,
  humanQuestions: 0,
  humanSnoozed: 0,
  generatedAt: 1_700_000_000_000,
  backend: "claude",
  model: "Opus 5.5 · xhigh",
  background: { running: 0, jobs: 0, waiting: 0, total: 0, paused: 0 },
  today: { archivedNotifications: 0, notesSaved: 0, remindersSet: 0, cardsWithdrawn: 0, since: 1_700_000_000_000 },
  radar: { activeProjects: 0, stalledProjects: 0, somedayProjects: 0, nextReviewAt: 1_700_000_000_000 },
  statusLine: { inbox: "", radar: "", agents: "" },
  notifications: [],
};

function sampleModels(workerSel: ModelsDTO["roles"]["worker"] = { mode: "inherit" }): ModelsDTO {
  const claudeCat = {
    engine: "claude" as const,
    models: [
      { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "haiku", label: "Haiku 5", efforts: [] },
    ],
    recommended: { model: "opus", label: "Opus 5.5", effort: "xhigh" },
    recommendedFast: { model: "haiku", label: "Haiku 5" },
    fetchedAt: 1_700_000_000_000,
    error: null,
    selection: { strong: { mode: "auto" as const }, fast: { mode: "auto" as const } },
    effective: {
      strong: { model: "opus", label: "Opus 5.5", effort: "xhigh" },
      fast: { model: "haiku", label: "Haiku 5" },
    },
  };
  const codexCat = {
    engine: "codex" as const,
    models: [{ id: "gpt-6-codex", label: "GPT-6 Codex", efforts: ["low", "high", "xhigh"] }],
    recommended: { model: "gpt-6-codex", label: "GPT-6 Codex", effort: "xhigh" },
    recommendedFast: { model: "gpt-6-codex", label: "GPT-6 Codex", effort: "low" },
    fetchedAt: 1_700_000_000_000,
    error: null,
    selection: { strong: { mode: "auto" as const }, fast: { mode: "auto" as const } },
    effective: {
      strong: { model: "gpt-6-codex", label: "GPT-6 Codex", effort: "xhigh" },
      fast: { model: "gpt-6-codex", label: "GPT-6 Codex", effort: "low" },
    },
  };
  const workerEff = workerSel.mode === "custom"
    ? {
        runner: workerSel.runner,
        choice: {
          model: workerSel.model ?? "gpt-6-codex",
          label: "GPT-6 Codex",
          effort: workerSel.effort ?? "xhigh",
        },
        inherited: false,
      }
    : { runner: "claude" as const, choice: claudeCat.effective.strong, inherited: true };

  return {
    available: true,
    engine: "claude",
    runners: ["claude", "codex"],
    models: claudeCat.models,
    recommended: claudeCat.recommended,
    recommendedFast: claudeCat.recommendedFast,
    fetchedAt: claudeCat.fetchedAt,
    error: null,
    selection: claudeCat.selection,
    effective: claudeCat.effective,
    catalogs: { claude: claudeCat, codex: codexCat },
    roles: {
      desk: { mode: "inherit" },
      project: { mode: "inherit" },
      worker: workerSel,
      hub: { mode: "inherit" },
      checker: { mode: "inherit" },
      sensor: { mode: "inherit" },
    },
    effectiveRoles: {
      desk: { runner: "claude", choice: claudeCat.effective.strong, inherited: true },
      project: { runner: "claude", choice: claudeCat.effective.strong, inherited: true },
      worker: workerEff,
      hub: { runner: "claude", choice: claudeCat.effective.strong, inherited: true },
      checker: { runner: "claude", choice: claudeCat.effective.fast, inherited: true },
      sensor: { runner: "claude", choice: claudeCat.effective.fast, inherited: true },
    },
  };
}

async function selectValue(label: string, value: string) {
  const el = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(el, `select "${label}" should exist`).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("lets the owner configure per-role runner, model and effort in the model panel", async () => {
  let state = sampleModels();
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/models" && method === "GET") return Response.json(state);
    if (path === "/api/models" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      puts.push(body);
      if (body["role"] === "worker") {
        state = sampleModels(
          body["mode"] === "inherit"
            ? { mode: "inherit" }
            : {
                mode: "custom",
                runner: body["runner"] as "claude" | "codex",
                ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
                ...(typeof body["effort"] === "string" ? { effort: body["effort"] } : {}),
              },
        );
      }
      return Response.json(state);
    }
    return Response.json({}, { status: 404 });
  });

  await act(async () => {
    root.render(createElement(RefreshProvider, null, createElement(ModelSwitch, { status: STATUS })));
  });

  // Open the popover
  const trigger = document.querySelector<HTMLButtonElement>(".model-trigger")!;
  await act(async () => {
    trigger.click();
  });

  expect(document.body.textContent).toContain("按层级默认");
  expect(document.body.textContent).toContain("执行分身");

  // Pick Codex as the runner for worker, then choose model and effort, then reset to inherit
  await selectValue("执行分身 Runner", "codex");
  await selectValue("执行分身 模型", "gpt-6-codex");
  await selectValue("执行分身 推理强度", "low");
  expect(document.body.textContent).toContain("Codex · GPT-6 Codex · low");

  await selectValue("执行分身 Runner", "");
  expect(puts).toEqual([
    { role: "worker", mode: "custom", runner: "codex" },
    { role: "worker", mode: "custom", runner: "codex", model: "gpt-6-codex" },
    { role: "worker", mode: "custom", runner: "codex", model: "gpt-6-codex", effort: "low" },
    { role: "worker", mode: "inherit" },
  ]);
});
