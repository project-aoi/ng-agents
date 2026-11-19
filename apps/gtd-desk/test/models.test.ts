import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelSettings } from "@ng/cell";
import type { CliModelCatalog, CliModelInfo } from "@ng/loop";
import { ManualClock, NgError, type CliEngine } from "@ng/protocol";
import type { ApiError, ModelsDTO, StatusDTO } from "../src/shared/api";
import { createModelSwitch } from "../src/server/models";
import { bootDesk, cleanupAll, MIN, T0, tempDir } from "./helpers";

// The owner's model switch over HTTP (/api/models, and the model in /api/status). The catalogue is injected through
// the kernel's `modelSwitch.fetch`: no CLI is run (the configured binary does not exist).

afterEach(cleanupAll);

const OPUS: CliModelInfo = { id: "opus", label: "Opus 5.5", description: "Most capable for complex work", efforts: ["low", "medium", "high", "xhigh", "max"] };
const SONNET: CliModelInfo = { id: "sonnet", label: "Sonnet 5", efforts: ["low", "medium", "high"] };
const HAIKU: CliModelInfo = { id: "haiku", label: "Haiku 5", efforts: [] };

function catalogueSource(clock: ManualClock) {
  const calls: CliEngine[] = [];
  let models: CliModelInfo[] = [OPUS, SONNET, HAIKU];
  let failWith: string | null = null;
  return {
    calls,
    setModels(m: CliModelInfo[]) {
      models = m;
    },
    failNext(message: string) {
      failWith = message;
    },
    fetch: async (engine: CliEngine): Promise<CliModelCatalog> => {
      calls.push(engine);
      if (failWith) {
        const message = failWith;
        failWith = null;
        throw new Error(message);
      }
      return { engine, models, recommended: { model: models[0]!.id, effort: "xhigh" }, fetchedAt: clock.now() };
    },
  };
}

/** A desk whose agents are (nominally) Claude Code, with the switch's catalogue injected. */
async function bootCliDesk() {
  const clock = new ManualClock(T0);
  const src = catalogueSource(clock);
  const d = await bootDesk({
    clock,
    model: undefined,
    env: { NG_AGENT_BACKEND: "claude", NG_CLAUDE_BIN: "/nonexistent/ng-test-claude" },
    detectCli: () => true,
    kernel: { modelSwitch: { fetch: src.fetch } },
  });
  return { d, src, clock };
}

const put = (d: Awaited<ReturnType<typeof bootDesk>>, body: unknown) => d.req<ModelsDTO & ApiError>("PUT", "/api/models", body);

describe("GET/PUT /api/models on a CLI backend", () => {
  it("lists the CLI's models, its recommendation, the selection and what each tier runs on", async () => {
    const { d, src } = await bootCliDesk();
    expect(d.kernel.agentBackend).toBe("claude");
    const m = await d.get<ModelsDTO>("/api/models");
    expect(m).toEqual({
      available: true,
      engine: "claude",
      models: [OPUS, SONNET, HAIKU],
      recommended: { model: "opus", label: "Opus 5.5", effort: "xhigh" },
      // the fast tier's auto choice is the light model the CLI lists, not the flagship at its top effort
      recommendedFast: { model: "haiku", label: "Haiku 5" },
      fetchedAt: T0,
      error: null,
      selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
      effective: { strong: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, fast: { model: "haiku", label: "Haiku 5" } },
    });
    // fetched once (at kernel start); a plain GET uses the cached list
    expect(src.calls).toEqual(["claude"]);
    const status = await d.get<StatusDTO>("/api/status");
    expect(status).toMatchObject({ backend: "claude", demo: false, model: "Opus 5.5 · xhigh" });
  });

  it("PUT a fixed model and effort: the answer, a later GET and the top bar reflect it, and it is saved", async () => {
    const { d } = await bootCliDesk();
    const r = await put(d, { tier: "strong", mode: "fixed", model: "sonnet", effort: "medium" });
    expect(r.status).toBe(200);
    expect(r.json.selection.strong).toEqual({ mode: "fixed", model: "sonnet", effort: "medium" });
    expect(r.json.effective.strong).toEqual({ model: "sonnet", label: "Sonnet 5", effort: "medium" });
    expect(r.json.effective.fast).toEqual({ model: "haiku", label: "Haiku 5" });

    const m = await d.get<ModelsDTO>("/api/models");
    expect(m.selection).toEqual({ strong: { mode: "fixed", model: "sonnet", effort: "medium" }, fast: { mode: "auto" } });
    expect((await d.get<StatusDTO>("/api/status")).model).toBe("Sonnet 5 · medium");

    // a fixed model without an effort runs at its preferred one; one without efforts at none
    const fast = await put(d, { tier: "fast", mode: "fixed", model: "sonnet" });
    expect(fast.json.effective.fast).toEqual({ model: "sonnet", label: "Sonnet 5", effort: "high" });
    const haiku = await put(d, { tier: "fast", mode: "fixed", model: "haiku" });
    expect(haiku.json.effective.fast).toEqual({ model: "haiku", label: "Haiku 5" });

    const saved = JSON.parse(readFileSync(join(d.kernel.dataDir, "models.json"), "utf8")) as unknown;
    expect(saved).toEqual({ claude: { strong: { mode: "fixed", model: "sonnet", effort: "medium" }, fast: { mode: "fixed", model: "haiku" } } });
  });

  it("refuses a model or an effort the CLI does not list (400 with the reason) and changes nothing", async () => {
    const { d } = await bootCliDesk();
    const unknown = await put(d, { tier: "strong", mode: "fixed", model: "gpt-6" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.code).toBe("invalid_argument");
    expect(unknown.json.error.message).toContain('"gpt-6"');
    expect(unknown.json.error.message).toContain("opus, sonnet, haiku");

    const effort = await put(d, { tier: "strong", mode: "fixed", model: "sonnet", effort: "xhigh" });
    expect(effort.status).toBe(400);
    expect(effort.json.error.message).toContain('"xhigh"');

    expect((await put(d, { tier: "medium", mode: "auto" })).status).toBe(400);
    expect((await put(d, { tier: "strong", mode: "fixed" })).status).toBe(400);
    expect((await put(d, {})).status).toBe(400);
    const bad = await d.server.app.request("/api/models", { method: "PUT", headers: { "content-type": "application/json" }, body: "{ nope" });
    expect(bad.status).toBe(400);

    expect((await d.get<ModelsDTO>("/api/models")).selection).toEqual({ strong: { mode: "auto" }, fast: { mode: "auto" } });
  });

  it("PUT auto goes back to following the CLI's recommendation", async () => {
    const { d } = await bootCliDesk();
    await put(d, { tier: "strong", mode: "fixed", model: "haiku" });
    expect((await d.get<StatusDTO>("/api/status")).model).toBe("Haiku 5");
    const r = await put(d, { tier: "strong", mode: "auto" });
    expect(r.status).toBe(200);
    expect(r.json.selection.strong).toEqual({ mode: "auto" });
    expect(r.json.effective.strong).toEqual({ model: "opus", label: "Opus 5.5", effort: "xhigh" });
    expect((await d.get<StatusDTO>("/api/status")).model).toBe("Opus 5.5 · xhigh");
  });

  it("?refresh=1 asks the CLI again; a failed refresh keeps the list and reports the error", async () => {
    const { d, src, clock } = await bootCliDesk();
    await d.get("/api/models");
    expect(src.calls).toHaveLength(1);
    src.setModels([{ id: "opus-6", label: "Opus 6", efforts: ["high", "xhigh"] }, OPUS, SONNET]);
    clock.advance(5 * MIN);

    const m = await d.get<ModelsDTO>("/api/models?refresh=1");
    expect(src.calls).toHaveLength(2);
    expect(m.models.map((x) => x.id)).toEqual(["opus-6", "opus", "sonnet"]);
    expect(m.fetchedAt).toBe(T0 + 5 * MIN);
    // auto follows the new recommendation, and so does the top bar
    expect(m.effective.strong).toEqual({ model: "opus-6", label: "Opus 6", effort: "xhigh" });
    // no light model in the new list: fast runs the new first choice at a lower effort
    expect(m.recommendedFast).toEqual({ model: "opus-6", label: "Opus 6", effort: "high" });
    expect(m.effective.fast).toEqual({ model: "opus-6", label: "Opus 6", effort: "high" });
    expect((await d.get<StatusDTO>("/api/status")).model).toBe("Opus 6 · xhigh");

    src.failNext("claude: not logged in");
    const failed = await d.get<ModelsDTO>("/api/models?refresh=1");
    expect(src.calls).toHaveLength(3);
    expect(failed.error).toBe("claude: not logged in");
    expect(failed.models.map((x) => x.id)).toEqual(["opus-6", "opus", "sonnet"]);
    expect(failed.fetchedAt).toBe(T0 + 5 * MIN);
  });
});

describe("without a CLI backend", () => {
  it("GET answers available:false, PUT is refused, and the top bar has no model", async () => {
    const d = await bootDesk();
    expect(d.kernel.agentBackend).toBe("api");
    expect(await d.get<ModelsDTO>("/api/models")).toEqual({
      available: false,
      engine: null,
      models: [],
      recommended: null,
      fetchedAt: null,
      error: null,
      selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
      effective: { strong: null, fast: null },
    });
    expect((await d.get<ModelsDTO>("/api/models?refresh=1")).available).toBe(false);
    const r = await put(d, { tier: "strong", mode: "auto" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("unsupported");
    expect(await d.get<StatusDTO>("/api/status")).not.toHaveProperty("model");
  });
});

describe("createModelSwitch", () => {
  const settingsWith = (fetch: (e: CliEngine) => Promise<CliModelCatalog>, clock = new ManualClock(T0)) =>
    createModelSettings({ engine: "codex", dataDir: tempDir("models"), clock, fetch, firstFetchWaitMs: 20 });

  it("no switch: nothing to show, nothing to set, no label", async () => {
    const sw = createModelSwitch({ modelSettings: () => null });
    expect((await sw.view()).available).toBe(false);
    await expect(sw.set({ tier: "strong", mode: "auto" })).rejects.toBeInstanceOf(NgError);
    expect(sw.label()).toBeNull();
  });

  it("a CLI that cannot list its models: the view carries the error instead of failing; a fixed model is labelled by its id", async () => {
    const settings = settingsWith(async () => {
      throw new Error("codex: command not found");
    });
    const sw = createModelSwitch({ modelSettings: () => settings });
    const v = await sw.view();
    expect(v).toMatchObject({ available: true, engine: "codex", models: [], recommended: null, fetchedAt: null, error: "codex: command not found" });
    expect(v.effective).toEqual({ strong: null, fast: null });
    expect(sw.label()).toBeNull(); // auto with nothing known: the CLI's own default
    // with no list to check against, a fixed choice is taken as given
    const after = await sw.set({ tier: "strong", mode: "fixed", model: "gpt-6-codex", effort: "high" });
    expect(after.effective.strong).toEqual({ model: "gpt-6-codex", label: "gpt-6-codex", effort: "high" });
    expect(sw.label()).toBe("gpt-6-codex · high");
  });

  it("labels the main (strong) tier with the CLI's own display name", async () => {
    const clock = new ManualClock(T0);
    const settings = settingsWith(async (engine) => ({
      engine,
      models: [{ id: "gpt-6-codex", label: "GPT-6 Codex", efforts: ["low", "high", "xhigh"] }, { id: "gpt-6-mini", label: "GPT-6 mini", efforts: [] }],
      recommended: { model: "gpt-6-codex", effort: "xhigh" },
      fetchedAt: clock.now(),
    }), clock);
    const sw = createModelSwitch({ modelSettings: () => settings });
    expect(sw.label()).toBeNull(); // nothing fetched yet
    await sw.view();
    expect(sw.label()).toBe("GPT-6 Codex · xhigh");
    await sw.set({ tier: "fast", mode: "fixed", model: "gpt-6-mini" });
    expect(sw.label()).toBe("GPT-6 Codex · xhigh");
    await sw.set({ tier: "strong", mode: "fixed", model: "gpt-6-mini" });
    expect(sw.label()).toBe("GPT-6 mini");
  });
});
