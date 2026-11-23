import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelSettings } from "@ng/cell";
import { CLI_SESSION_KEY, type CliModelCatalog, type CliModelInfo, type CliSessionRecord } from "@ng/loop";
import { installFakeCli } from "@ng/loop/testing";
import { ManualClock, NgError, type CliEngine } from "@ng/protocol";
import type { ApiError, ModelsDTO, StatusDTO, TopologyDTO } from "../src/shared/api";
import { createModelSwitch } from "../src/server/models";
import { bootDesk, bootRealDesk, cleanupAll, MIN, T0, tempDir } from "./helpers";

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
      runners: ["claude"],
      models: [OPUS, SONNET, HAIKU],
      recommended: { model: "opus", label: "Opus 5.5", effort: "xhigh" },
      // the fast tier's auto choice is the light model the CLI lists, not the flagship at its top effort
      recommendedFast: { model: "haiku", label: "Haiku 5" },
      fetchedAt: T0,
      error: null,
      selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
      effective: { strong: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, fast: { model: "haiku", label: "Haiku 5" } },
      catalogs: {
        claude: {
          engine: "claude",
          models: [OPUS, SONNET, HAIKU],
          recommended: { model: "opus", label: "Opus 5.5", effort: "xhigh" },
          recommendedFast: { model: "haiku", label: "Haiku 5" },
          fetchedAt: T0,
          error: null,
          selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
          effective: { strong: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, fast: { model: "haiku", label: "Haiku 5" } },
        },
      },
      roles: {
        desk: { mode: "inherit" },
        project: { mode: "inherit" },
        worker: { mode: "inherit" },
        hub: { mode: "inherit" },
        checker: { mode: "inherit" },
        sensor: { mode: "inherit" },
      },
      effectiveRoles: {
        desk: { runner: "claude", choice: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, inherited: true },
        project: { runner: "claude", choice: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, inherited: true },
        worker: { runner: "claude", choice: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, inherited: true },
        hub: { runner: "claude", choice: { model: "opus", label: "Opus 5.5", effort: "xhigh" }, inherited: true },
        checker: { runner: "claude", choice: { model: "haiku", label: "Haiku 5" }, inherited: true },
        sensor: { runner: "claude", choice: { model: "haiku", label: "Haiku 5" }, inherited: true },
      },
    });
    // fetched once (at kernel start); a plain GET uses the cached list
    expect(src.calls).toEqual(["claude"]);
    const status = await d.get<StatusDTO>("/api/status");
    expect(status).toMatchObject({ backend: "claude", model: "Opus 5.5 · xhigh" });
    const stream = await d.server.app.request("/api/events", { headers: {authorization: `Bearer ${d.server.security.token}`} });
    const reader = stream.body!.getReader();
    try {
      let frame = "";
      const decoder = new TextDecoder();
      while (!frame.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("status stream closed before hello");
        frame += decoder.decode(chunk.value, { stream: true });
      }
      expect(frame).toContain("event: hello");
      const data = frame.split("\n").find(line => line.startsWith("data: "))!;
      expect(JSON.parse(data.slice(6)).status).toEqual(status);
    } finally {
      await reader.cancel();
    }
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
    const bad = await d.server.app.request("/api/models", { method: "PUT", headers: { authorization: `Bearer ${d.server.security.token}`, "content-type": "application/json" }, body: "{ nope" });
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
    expect(d.kernel.agentBackend).toBeNull();
    expect(await d.get<ModelsDTO>("/api/models")).toEqual({
      available: false,
      engine: null,
      runners: [],
      models: [],
      recommended: null,
      fetchedAt: null,
      error: null,
      selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
      effective: { strong: null, fast: null },
      catalogs: {},
      roles: {
        desk: { mode: "inherit" },
        project: { mode: "inherit" },
        worker: { mode: "inherit" },
        hub: { mode: "inherit" },
        checker: { mode: "inherit" },
        sensor: { mode: "inherit" },
      },
      effectiveRoles: { desk: null, project: null, worker: null, hub: null, checker: null, sensor: null },
    });
    expect((await d.get<ModelsDTO>("/api/models?refresh=1")).available).toBe(false);
    const r = await put(d, { tier: "strong", mode: "auto" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("unsupported");
    expect(await d.get<StatusDTO>("/api/status")).not.toHaveProperty("model");
  });
});

describe("runner selection", () => {
  it("advertises real options to launch tools and routes the desk, project and worker with their chosen models", async () => {
    const dataDir = tempDir("runners-data");
    const bins = tempDir("runners-bin");
    const claude = installFakeCli(bins, "claude", [
      { actions: [
        { mcp: "start_project", args: { title: "查一下", outcome: "核对记录", brief: "核对记录", runner: "codex", model: "codex-test", effort: "low" } },
        { text: "已立项" },
      ] },
      { actions: [{ text: "已核对" }] },
      { actions: [{ text: "补充已核对" }] },
    ]);
    const codex = installFakeCli(bins, "codex", [
      { actions: [
        { mcp: "dispatch", args: { title: "无效选项", instruction: "核对记录", runner: "agy" } },
        { mcp: "dispatch", args: { title: "核对记录", instruction: "核对记录", runner: "claude", model: "sonnet", effort: "medium" } },
        { text: "已派工" },
      ] },
    ]);
    const clock = new ManualClock(T0);
    const fetch = async (engine: CliEngine): Promise<CliModelCatalog> => ({
      engine,
      models: engine === "claude" ? [OPUS, SONNET] : [{ id: "codex-test", label: "Codex Test", efforts: ["low", "high"] }],
      recommended: engine === "claude" ? { model: "opus", effort: "high" } : { model: "codex-test", effort: "high" },
      fetchedAt: clock.now(),
    });
    const env = { NG_AGENT_RUNNERS: "claude,codex", NG_CLAUDE_BIN: claude.bin, NG_CODEX_BIN: codex.bin };
    const opts = {
      dataDir, clock, env, detectCli: () => true,
      kernel: { modelSwitch: { fetch }, cli: { claude: { bin: claude.bin, env: claude.env }, codex: { bin: codex.bin, env: codex.env } } },
    };
    const d = await bootRealDesk(opts);
    await d.post("/api/cells/desk/messages", { text: "请核对记录", clientId: "open" });
    await d.kernel.idle();

    const project = d.kernel.listCells({ parentId: "desk" }).find((c) => c.preset === "project")!;
    const workers = d.kernel.listCells({ parentId: project.id });
    expect(workers).toHaveLength(1);
    const [worker] = workers;
    expect(project.spec.processor).toMatchObject({ engine: "codex", model: "codex-test", effort: "low" });
    expect(worker!.spec.processor).toMatchObject({ engine: "claude", model: "sonnet", effort: "medium" });
    expect(claude.launches()[0]).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(codex.launches()[0]).toEqual(expect.arrayContaining(["-m", "codex-test", 'model_reasoning_effort="low"']));
    expect(claude.launches()[1]).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "medium"]));
    expect(codex.log().find((entry) => entry.type === "mcp_result" && entry.name === "dispatch")).toMatchObject({ isError: true });

    const deskDescriptions = claude.log().find((entry) => entry.type === "mcp_ready")!["descriptions"];
    const projectDescriptions = codex.log().find((entry) => entry.type === "mcp_ready")!["descriptions"];
    expect(deskDescriptions).toMatchObject({ start_project: expect.stringContaining('codex: "codex-test" (effort: "low", "high")') });
    expect(projectDescriptions).toMatchObject({ dispatch: expect.stringContaining('- claude: "opus"') });
    expect(JSON.stringify(projectDescriptions)).not.toContain("- agy:");

    const session = d.kernel.context.readStateSync<CliSessionRecord>(worker!.id, CLI_SESSION_KEY);
    expect(session).toMatchObject({ engine: "claude", model: "sonnet@medium" });
    expect((await put(d, { runner: "agy" })).status).toBe(400);
    expect((await put(d, { runner: "codex" })).json).toMatchObject({ engine: "codex", runners: ["claude", "codex"] });
    expect(await d.get<StatusDTO>("/api/status")).toMatchObject({ backend: "codex", model: "Codex Test · high" });
    expect((await put(d, { tier: "strong", engine: "claude", mode: "auto" })).status).toBe(409);
    const topology = await d.get<TopologyDTO>("/api/agents/topology");
    expect(topology.nodes.find((n) => n.cellId === worker!.id)).toMatchObject({ engine: "claude", modelOverride: { model: "sonnet", effort: "medium" } });

    await d.post(`/api/cells/${worker!.id}/messages`, { text: "请再核对", clientId: "follow-up" });
    await d.post("/api/cells/desk/messages", { text: "还好吗", clientId: "switch" });
    await d.kernel.idle();
    expect(d.kernel.context.readStateSync(worker!.id, CLI_SESSION_KEY)).toMatchObject({ sessionId: session!.sessionId, engine: "claude" });
    expect(d.kernel.context.readStateSync("desk", CLI_SESSION_KEY)).toMatchObject({ engine: "codex", model: "codex-test@high" });
    expect(await d.kernel.describeRunnerOptions()).toContain("Default runner: codex");

    await d.server.close();
    const restarted = await bootRealDesk(opts);
    expect((await restarted.get<ModelsDTO>("/api/models")).engine).toBe("codex");
    const docs = await restarted.req<{ tools: Array<{ name: string; description: string }> }>("GET", "/api/agent/tools");
    expect(docs.json.tools.find((t) => t.name === "create_project")?.description).toContain('Default runner: codex');
    const spawn = { preset: "worker", title: "外部检查", instruction: "核对记录", model: "sonnet" };
    const invalid = await restarted.req<{ isError: boolean; text: string }>("POST", "/api/agent/tools/spawn_cell", spawn);
    expect(invalid.json).toMatchObject({ isError: true, text: expect.stringContaining('Runner codex does not list model "sonnet"') });
    expect(restarted.kernel.listCells({ parentId: "desk" })).toHaveLength(0);
    const started = await restarted.req<{ data: { cellId: string } }>("POST", "/api/agent/tools/spawn_cell", { ...spawn, runner: "claude", effort: "medium" });
    expect(restarted.kernel.getCell(started.json.data.cellId)?.spec.processor).toMatchObject({ engine: "claude", model: "sonnet", effort: "medium" });
    await restarted.kernel.idle();
  });

  it("supports per-role default runner/model/effort, effort-only overrides, auto-discovery and catalog error cooldown", async () => {
    const dataDir = tempDir("roles-data");
    const bins = tempDir("roles-bin");
    const claude = installFakeCli(bins, "claude", [
      // Turn 1: desk starts project with no explicit runner/model/effort (uses project role default)
      { actions: [
        { mcp: "start_project", args: { title: "分层测试", outcome: "完成多阶段执行", brief: "按阶段执行" } },
        { text: "已立项" },
      ] },
      // Turn 2: project (on claude sonnet · medium) dispatches 3 workers + 1 invalid effort
      { actions: [
        { mcp: "dispatch", args: { title: "默认分身", instruction: "阶段 1：走 worker 层级默认" } },
        { mcp: "dispatch", args: { title: "降档分身", instruction: "阶段 2：只改 effort", effort: "low" } },
        { mcp: "dispatch", args: { title: "跨引擎分身", instruction: "阶段 3：指定 runner 和 effort", runner: "claude", effort: "low" } },
        { mcp: "dispatch", args: { title: "非法强度", instruction: "无效测试", effort: "ultra" } },
        { text: "已分阶段派工" },
      ] },
      // Turn 3: Worker C on claude (opus · low)
      { actions: [{ text: "跨引擎完成" }] },
    ]);
    const codex = installFakeCli(bins, "codex", [
      // Worker A (codex · codex-test · high from worker role default)
      { actions: [{ text: "默认分身完成" }] },
      // Worker B (codex · codex-test · low from effort-only override)
      { actions: [{ text: "降档分身完成" }] },
    ]);
    const clock = new ManualClock(T0);
    const fetch = async (engine: CliEngine): Promise<CliModelCatalog> => ({
      engine,
      models: engine === "claude" ? [OPUS, SONNET, HAIKU] : [{ id: "codex-test", label: "Codex Test", efforts: ["low", "high"] }],
      recommended: engine === "claude" ? { model: "opus", effort: "xhigh" } : { model: "codex-test", effort: "high" },
      fetchedAt: clock.now(),
    });
    // Auto-discovery without NG_AGENT_RUNNERS enables all detected CLIs (claude + codex).
    const env = { NG_CLAUDE_BIN: claude.bin, NG_CODEX_BIN: codex.bin };
    const opts = {
      dataDir,
      clock,
      env,
      detectCli: (engine: CliEngine) => engine === "claude" || engine === "codex",
      kernel: { modelSwitch: { fetch }, cli: { claude: { bin: claude.bin, env: claude.env }, codex: { bin: codex.bin, env: codex.env } } },
    };
    const d = await bootRealDesk(opts);
    const initial = await d.get<ModelsDTO>("/api/models");
    expect(initial.runners).toEqual(["claude", "codex"]);
    expect(Object.keys(initial.catalogs).sort()).toEqual(["claude", "codex"]);

    // Reject invalid role configurations without mutating state.
    expect((await put(d, { role: "unknown", mode: "inherit" })).status).toBe(400);
    expect((await put(d, { role: "worker", mode: "custom", runner: "agy" })).status).toBe(400);
    expect((await put(d, { role: "worker", mode: "custom", runner: "codex", model: "nope" })).status).toBe(400);
    expect((await put(d, { role: "worker", mode: "custom", runner: "codex", model: "codex-test", effort: "ultra" })).status).toBe(400);

    // Configure per-role defaults: project on claude sonnet·medium, worker on codex codex-test·high, checker on claude haiku.
    const rProject = await put(d, { role: "project", mode: "custom", runner: "claude", model: "sonnet", effort: "medium" });
    expect(rProject.status).toBe(200);
    const rWorker = await put(d, { role: "worker", mode: "custom", runner: "codex", model: "codex-test", effort: "high" });
    expect(rWorker.status).toBe(200);
    const rChecker = await put(d, { role: "checker", mode: "custom", runner: "claude", model: "haiku" });
    expect(rChecker.status).toBe(200);
    expect(rChecker.json.effectiveRoles).toMatchObject({
      desk: { runner: "claude", choice: { model: "opus", effort: "xhigh" }, inherited: true },
      project: { runner: "claude", choice: { model: "sonnet", effort: "medium" }, inherited: false },
      worker: { runner: "codex", choice: { model: "codex-test", effort: "high" }, inherited: false },
      checker: { runner: "claude", choice: { model: "haiku" }, inherited: false },
    });
    expect(JSON.parse(readFileSync(join(dataDir, "role-models.json"), "utf8"))).toEqual({
      project: { mode: "custom", runner: "claude", model: "sonnet", effort: "medium" },
      worker: { mode: "custom", runner: "codex", model: "codex-test", effort: "high" },
      checker: { mode: "custom", runner: "claude", model: "haiku" },
    });

    await d.post("/api/cells/desk/messages", { text: "开始分层测试", clientId: "role-run" });
    await d.kernel.idle();

    const project = d.kernel.listCells({ parentId: "desk" }).find((c) => c.preset === "project")!;
    const workers = d.kernel.listCells({ parentId: project.id });
    expect(workers).toHaveLength(3);
    const wDefault = workers.find((w) => w.title === "默认分身")!;
    const wEffort = workers.find((w) => w.title === "降档分身")!;
    const wCross = workers.find((w) => w.title === "跨引擎分身")!;

    // Project & default worker did not pin processor overrides; they followed role defaults dynamically.
    expect(project.spec.processor).not.toHaveProperty("engine");
    expect(wDefault.spec.processor).not.toHaveProperty("engine");
    // Effort-only override resolved against worker's role default (codex · codex-test) with effort=low.
    expect(wEffort.spec.processor).toMatchObject({ engine: "codex", model: "codex-test", effort: "low" });
    // Runner+effort override resolved against claude's strong model (opus) with effort=low.
    expect(wCross.spec.processor).toMatchObject({ engine: "claude", model: "opus", effort: "low" });

    // Check actual CLI launches:
    // claude launches: [0] desk (opus·xhigh), [1] project (sonnet·medium), [2] wCross (opus·low)
    expect(claude.launches()[0]).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "xhigh"]));
    expect(claude.launches()[1]).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "medium"]));
    expect(claude.launches()[2]).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "low"]));
    // codex launches: wDefault (codex-test·high) and wEffort (codex-test·low)
    const codexLaunches = codex.launches();
    expect(codexLaunches).toHaveLength(2);
    expect(codexLaunches.some((argv) => argv.includes("codex-test") && argv.includes('model_reasoning_effort="high"'))).toBe(true);
    expect(codexLaunches.some((argv) => argv.includes("codex-test") && argv.includes('model_reasoning_effort="low"'))).toBe(true);
    // Invalid effort call returned tool error
    expect(claude.log().some((e) => e.type === "mcp_result" && e.name === "dispatch" && e.isError === true)).toBe(true);

    // Topology accurately reflects per-role defaults & overrides.
    const topo = await d.get<TopologyDTO>("/api/agents/topology");
    expect(topo.nodes.find((n) => n.cellId === "desk")).toMatchObject({ engine: "claude", runnerSource: "default", effectiveModel: { model: "opus", effort: "xhigh" } });
    expect(topo.nodes.find((n) => n.cellId === project.id)).toMatchObject({ engine: "claude", runnerSource: "role", effectiveModel: { model: "sonnet", effort: "medium" } });
    expect(topo.nodes.find((n) => n.cellId === wDefault.id)).toMatchObject({ engine: "codex", runnerSource: "role", effectiveModel: { model: "codex-test", effort: "high" } });
    expect(topo.nodes.find((n) => n.cellId === wEffort.id)).toMatchObject({ engine: "codex", runnerSource: "override", modelOverride: { model: "codex-test", effort: "low" } });

    // External agent get_cell exposes effective runner/model/effort.
    const cellInfo = await d.req<{ data: { runner: string; model: string; effort: string } }>("POST", "/api/agent/tools/get_cell", { id: wDefault.id });
    expect(cellInfo.json.data).toMatchObject({ runner: "codex", model: "codex-test", effort: "high" });

    // Tool descriptions include role defaults summary.
    expect(await d.kernel.describeRunnerOptions()).toContain("worker=codex (codex-test · high)");

    // Restart preserves role-models.json; resetting to inherit removes the role override.
    await d.server.close();
    const restarted = await bootRealDesk(opts);
    const afterRestart = await restarted.get<ModelsDTO>("/api/models");
    expect(afterRestart.roles.worker).toEqual({ mode: "custom", runner: "codex", model: "codex-test", effort: "high" });
    const reset = await put(restarted, { role: "worker", mode: "inherit" });
    expect(reset.status).toBe(200);
    expect(reset.json.roles.worker).toEqual({ mode: "inherit" });
    expect(reset.json.effectiveRoles.worker).toMatchObject({ runner: "claude", inherited: true });
    await restarted.server.close();
  });

  it("caches catalogue fetch failures within cooldown so describeRunnerOptions does not repeatedly block", async () => {
    const clock = new ManualClock(T0);
    const calls: Record<CliEngine, number> = { claude: 0, codex: 0, agy: 0 };
    const fetch = async (engine: CliEngine): Promise<CliModelCatalog> => {
      calls[engine]++;
      if (engine === "codex") throw new Error("codex: not logged in");
      return { engine, models: [OPUS, SONNET], recommended: { model: "opus", effort: "xhigh" }, fetchedAt: clock.now() };
    };
    const d = await bootDesk({
      clock,
      env: { NG_AGENT_RUNNERS: "claude,codex", NG_CLAUDE_BIN: "/nonexistent/claude", NG_CODEX_BIN: "/nonexistent/codex" },
      detectCli: () => true,
      kernel: { modelSwitch: { fetch, errorRetryMs: 60_000 } },
    });
    expect(calls.codex).toBe(1);
    await d.kernel.describeRunnerOptions();
    await d.get<ModelsDTO>("/api/models");
    // Still 1: failed fetch stays cooled down for automatic reads.
    expect(calls.codex).toBe(1);
    // Explicit refresh bypasses cooldown.
    await d.get<ModelsDTO>("/api/models?refresh=1");
    expect(calls.codex).toBe(2);
  });

  it("allows editing and clearing runnerOverride on a project proposal via savePlan", async () => {
    const clock = new ManualClock(T0);
    const fetch = async (engine: CliEngine): Promise<CliModelCatalog> => ({
      engine,
      models: engine === "claude" ? [OPUS, SONNET] : [{ id: "codex-test", label: "Codex Test", efforts: ["low", "high"] }],
      recommended: engine === "claude" ? { model: "opus", effort: "xhigh" } : { model: "codex-test", effort: "high" },
      fetchedAt: clock.now(),
    });
    const d = await bootDesk({
      clock,
      env: { NG_AGENT_RUNNERS: "claude,codex", NG_CLAUDE_BIN: "/nonexistent/claude", NG_CODEX_BIN: "/nonexistent/codex" },
      detectCli: () => true,
      kernel: { modelSwitch: { fetch } },
    });
    await d.get<ModelsDTO>("/api/models");
    const art = d.kernel.context.commitSync("desk", {
      artifact: {
        artifactId: "art_plan_runner",
        content: {
          format: "json",
          title: "测试方案",
          body: "{}",
          data: { title: "测试方案", outcome: "达成目标", actions: [{ title: "第一步", owner: "agent" }] },
        },
        updatedBy: "agent",
      },
    });
    expect(art.ok).toBe(true);
    const deskEpoch = d.kernel.getCell("desk")!.epoch;
    const auth = d.kernel.gate.authorizeSync(
      {
        type: "project.start",
        proposal: { title: "测试方案", outcome: "达成目标", actions: [{ title: "第一步", owner: "agent" }] },
        artifactId: "art_plan_runner",
        summary: "立项：测试方案",
        subjectKey: "plan:runner-test",
        sideEffect: "external",
        card: {
          format: "card",
          title: "测试方案",
          body: "达成目标",
          data: {
            cardType: "project_proposal",
            subjectKey: "plan:runner-test",
            title: "测试方案",
            source: { label: "工作台", at: T0 },
            rawInput: { text: "测试", kind: "message" },
            prep: { summary: "", checked: [] },
            proposal: { title: "测试方案", outcome: "达成目标", actions: [{ title: "第一步", owner: "agent" }] },
            draft: { artifactId: "art_plan_runner", version: 1 },
          },
        },
      },
      { cellId: "desk", epoch: deskEpoch, principalId: "cell:desk", artifactVersion: 1 },
    );
    expect(auth.type).toBe("defer");
    const cardId = auth.type === "defer" ? auth.actionId : "";
    const saved = await d.req<{ ok: boolean }>("PUT", `/api/human-items/${cardId}/plan`, {
      expectedVersion: 1,
      proposal: {
        title: "测试方案",
        outcome: "达成目标",
        runnerOverride: { engine: "codex", model: "codex-test", effort: "low" },
        actions: [{ title: "第一步", owner: "agent" }],
      },
    });
    expect(saved.status).toBe(200);
    expect(d.kernel.context.getArtifactSync("art_plan_runner")?.content.data).toMatchObject({
      runnerOverride: { engine: "codex", model: "codex-test", effort: "low" },
    });
    const cleared = await d.req<{ ok: boolean }>("PUT", `/api/human-items/${cardId}/plan`, {
      expectedVersion: 2,
      proposal: {
        title: "测试方案",
        outcome: "达成目标",
        runnerOverride: null,
        actions: [{ title: "第一步", owner: "agent" }],
      },
    });
    expect(cleared.status).toBe(200);
    expect(d.kernel.context.getArtifactSync("art_plan_runner")?.content.data).not.toHaveProperty("runnerOverride");
  });
});

describe("createModelSwitch", () => {
  const runnerControls = { cliRunners: ["codex"] as const, setDefaultRunner: () => undefined };
  const settingsWith = (fetch: (e: CliEngine) => Promise<CliModelCatalog>, clock = new ManualClock(T0)) =>
    createModelSettings({ engine: "codex", dataDir: tempDir("models"), clock, fetch, firstFetchWaitMs: 20 });

  it("no switch: nothing to show, nothing to set, no label", async () => {
    const sw = createModelSwitch({ ...runnerControls, modelSettings: () => null });
    expect((await sw.view()).available).toBe(false);
    await expect(sw.set({ tier: "strong", mode: "auto" })).rejects.toBeInstanceOf(NgError);
    expect(sw.label()).toBeNull();
  });

  it("a CLI that cannot list its models: the view carries the error instead of failing; a fixed model is labelled by its id", async () => {
    const settings = settingsWith(async () => {
      throw new Error("codex: command not found");
    });
    const sw = createModelSwitch({ ...runnerControls, modelSettings: () => settings });
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
    const sw = createModelSwitch({ ...runnerControls, modelSettings: () => settings });
    expect(sw.label()).toBeNull(); // nothing fetched yet
    await sw.view();
    expect(sw.label()).toBe("GPT-6 Codex · xhigh");
    await sw.set({ tier: "fast", mode: "fixed", model: "gpt-6-mini" });
    expect(sw.label()).toBe("GPT-6 Codex · xhigh");
    await sw.set({ tier: "strong", mode: "fixed", model: "gpt-6-mini" });
    expect(sw.label()).toBe("GPT-6 mini");
  });
});
