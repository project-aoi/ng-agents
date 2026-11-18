import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, NgError, type CliEngine } from "@ng/protocol";
import type { CliModelCatalog, CliModelInfo } from "@ng/loop";
import { createModelSettings, type ModelSettingsOptions } from "../src/models";

// The owner's model switch over an injected catalogue source and a manual clock: no CLI is asked.

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ng-models-"));
  dirs.push(d);
  return d;
}

const OPUS: CliModelInfo = { id: "opus", label: "Opus 5.5", description: "most capable", efforts: ["low", "medium", "high", "xhigh", "max"] };
const SONNET: CliModelInfo = { id: "sonnet", label: "Sonnet 5", efforts: ["low", "medium", "high"] };
const HAIKU: CliModelInfo = { id: "haiku", label: "Haiku 5", efforts: [] };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A catalogue source whose answers the test decides: a list, an error, or a hand-held promise. */
function source(clock: ManualClock) {
  const calls: CliEngine[] = [];
  const plan: Array<CliModelInfo[] | Error | Deferred<CliModelCatalog>> = [];
  let last: CliModelInfo[] = [OPUS, SONNET, HAIKU];
  const fetch = (engine: CliEngine): Promise<CliModelCatalog> => {
    calls.push(engine);
    const next = plan.shift() ?? last;
    if (next instanceof Error) return Promise.reject(next);
    if (!Array.isArray(next)) return next.promise;
    last = next;
    const first = next[0];
    const recommended = first ? { model: first.id, ...(first.efforts.includes("xhigh") ? { effort: "xhigh" } : {}) } : null;
    return Promise.resolve({ engine, models: next, recommended, fetchedAt: clock.now() });
  };
  return { fetch, calls, plan };
}

function setup(over: Partial<ModelSettingsOptions> = {}) {
  const clock = new ManualClock(T0);
  const src = source(clock);
  const dataDir = over.dataDir ?? tempDir();
  const errors: string[] = [];
  const make = (o: Partial<ModelSettingsOptions> = {}) =>
    createModelSettings({ engine: "claude", dataDir, clock, fetch: src.fetch, firstFetchWaitMs: 50, onError: (err, where) => errors.push(`${where}: ${String(err)}`), ...over, ...o });
  return { clock, src, dataDir, errors, settings: make(), make };
}

const stored = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "models.json"), "utf8")) as Record<string, unknown>;

describe("createModelSettings", () => {
  it("defaults to auto: a Run gets the CLI's recommendation", async () => {
    const { settings, src } = setup();
    expect(settings.view()).toMatchObject({ engine: "claude", catalog: null, error: null, selection: { strong: { mode: "auto" }, fast: { mode: "auto" } } });
    expect(settings.view().effective).toEqual({ strong: null, fast: null });

    expect(await settings.resolve("strong")).toEqual({ model: "opus", effort: "xhigh" });
    expect(await settings.resolve("fast")).toEqual({ model: "opus", effort: "xhigh" });
    expect(src.calls).toEqual(["claude"]); // one fetch, then the cached list
    expect(settings.view().effective).toEqual({ strong: { model: "opus", effort: "xhigh" }, fast: { model: "opus", effort: "xhigh" } });
    expect(settings.view().catalog?.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("auto follows the CLI when its recommendation changes", async () => {
    const { settings, src, clock } = setup({ ttlMs: 10 * MIN });
    await settings.catalog();
    src.plan.push([SONNET, OPUS]);
    clock.advance(11 * MIN);
    await settings.catalog();
    expect(await settings.resolve("strong")).toEqual({ model: "sonnet" });
  });

  it("static configuration becomes a fixed selection, its effort filled from the catalogue", async () => {
    const { settings } = setup({ initial: { strong: "sonnet", fast: "haiku" } });
    expect(settings.view().selection).toEqual({ strong: { mode: "fixed", model: "sonnet" }, fast: { mode: "fixed", model: "haiku" } });
    // Before any list is known, the fixed model is used as it is.
    expect(settings.view().effective).toEqual({ strong: { model: "sonnet" }, fast: { model: "haiku" } });
    await settings.catalog();
    expect(settings.view().effective).toEqual({ strong: { model: "sonnet", effort: "high" }, fast: { model: "haiku" } });
    expect(await settings.resolve("strong")).toEqual({ model: "sonnet", effort: "high" });
    expect(await settings.resolve("fast")).toEqual({ model: "haiku" });
  });

  it("an owner's saved selection wins over the static configuration", async () => {
    const { settings, make } = setup({ initial: { strong: "sonnet" } });
    await settings.catalog();
    settings.select("strong", { mode: "auto" });
    expect(make().view().selection.strong).toEqual({ mode: "auto" });
  });

  it("select validates against the catalogue", async () => {
    const { settings } = setup();
    await settings.catalog();
    const fail = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(NgError);
        expect((err as NgError).code).toBe("invalid_argument");
        return (err as Error).message;
      }
      throw new Error("expected select to throw");
    };
    expect(fail(() => settings.select("strong", { mode: "fixed", model: "gpt-6" }))).toMatch(/does not list a model "gpt-6".*opus, sonnet, haiku/);
    expect(fail(() => settings.select("strong", { mode: "fixed", model: "sonnet", effort: "xhigh" }))).toMatch(/Sonnet 5 does not offer effort "xhigh".*low, medium, high/);
    expect(fail(() => settings.select("fast", { mode: "fixed", model: "haiku", effort: "low" }))).toMatch(/offers: none/);
    expect(fail(() => settings.select("strong", { mode: "fixed", model: "  " }))).toMatch(/a model selection is/);
    expect(fail(() => settings.select("strong", { mode: "manual" } as never))).toMatch(/a model selection is/);
    expect(fail(() => settings.select("medium" as never, { mode: "auto" }))).toMatch(/unknown model tier/);
    // nothing was changed by the refused ones
    expect(settings.view().selection).toEqual({ strong: { mode: "auto" }, fast: { mode: "auto" } });
  });

  it("before any catalogue is known, a fixed selection is taken as it is", () => {
    const { settings } = setup();
    settings.select("strong", { mode: "fixed", model: "opus-next", effort: "ultra" });
    expect(settings.view().selection.strong).toEqual({ mode: "fixed", model: "opus-next", effort: "ultra" });
  });

  it("persists per engine in <dataDir>/models.json; a second instance reads it back; other engines' entries are kept", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "models.json"), JSON.stringify({ codex: { strong: { mode: "fixed", model: "gpt-6-codex", effort: "high" } } }));
    const { settings, make } = setup({ dataDir });
    await settings.catalog();
    settings.select("strong", { mode: "fixed", model: "opus", effort: "max" });
    settings.select("fast", { mode: "fixed", model: "sonnet" });

    expect(stored(dataDir)).toEqual({
      codex: { strong: { mode: "fixed", model: "gpt-6-codex", effort: "high" } },
      claude: { strong: { mode: "fixed", model: "opus", effort: "max" }, fast: { mode: "fixed", model: "sonnet" } },
    });
    const again = make();
    expect(again.view().selection).toEqual({ strong: { mode: "fixed", model: "opus", effort: "max" }, fast: { mode: "fixed", model: "sonnet" } });
    expect(await again.resolve("strong")).toEqual({ model: "opus", effort: "max" });
    expect(await again.resolve("fast")).toEqual({ model: "sonnet", effort: "high" });
    // The codex switch on the same directory sees its own entry only.
    const codex = make({ engine: "codex" });
    expect(codex.view().selection).toEqual({ strong: { mode: "fixed", model: "gpt-6-codex", effort: "high" }, fast: { mode: "auto" } });
  });

  it("a damaged models.json is ignored rather than fatal", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "models.json"), "{ not json");
    const { settings } = setup({ dataDir, initial: { fast: "haiku" } });
    expect(settings.view().selection).toEqual({ strong: { mode: "auto" }, fast: { mode: "fixed", model: "haiku" } });
    settings.select("strong", { mode: "fixed", model: "opus" });
    expect(stored(dataDir)).toEqual({ claude: { strong: { mode: "fixed", model: "opus" }, fast: { mode: "fixed", model: "haiku" } } });
  });

  it("TTL: a fresh catalogue is reused, a stale one is fetched again, refresh always asks", async () => {
    const { settings, src, clock } = setup({ ttlMs: 30 * MIN });
    await settings.catalog();
    clock.advance(29 * MIN);
    await settings.catalog();
    expect(src.calls).toHaveLength(1);
    await settings.catalog({ refresh: true });
    expect(src.calls).toHaveLength(2);
    clock.advance(31 * MIN);
    src.plan.push([OPUS, SONNET, HAIKU, { id: "opus-6", label: "Opus 6", efforts: ["high", "xhigh"] }]);
    const c = await settings.catalog();
    expect(src.calls).toHaveLength(3);
    expect(c.models.map((m) => m.id)).toContain("opus-6");
    expect(c.fetchedAt).toBe(clock.now());
  });

  it("a Run with a stale catalogue starts with what is known and refreshes in the background", async () => {
    const { settings, src, clock } = setup({ ttlMs: 30 * MIN });
    await settings.catalog();
    clock.advance(31 * MIN);
    src.plan.push([SONNET, OPUS]);
    expect(await settings.resolve("strong")).toEqual({ model: "opus", effort: "xhigh" });
    expect(src.calls).toHaveLength(2);
    await settings.catalog(); // the background fetch has landed
    expect(await settings.resolve("strong")).toEqual({ model: "sonnet" });
  });

  it("a failed refresh keeps the last good list and reports the error in view()", async () => {
    const { settings, src, clock, errors } = setup({ ttlMs: 30 * MIN });
    await settings.catalog();
    clock.advance(31 * MIN);
    src.plan.push(new Error("claude: not logged in"));
    const c = await settings.catalog();
    expect(c.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(settings.view().error).toBe("claude: not logged in");
    expect(settings.view().catalog?.fetchedAt).toBe(T0);
    expect(errors).toEqual(["list the models of claude: Error: claude: not logged in"]);
    expect(await settings.resolve("strong")).toEqual({ model: "opus", effort: "xhigh" });
    // the next good answer clears the error
    await settings.catalog({ refresh: true });
    expect(settings.view().error).toBeNull();
  });

  it("no catalogue and the fetch fails: resolve gives undefined (the CLI's default), catalog() rejects", async () => {
    const { settings, src } = setup();
    src.plan.push(new Error("spawn claude ENOENT"));
    expect(await settings.resolve("strong")).toBeUndefined();
    expect(settings.view()).toMatchObject({ catalog: null, error: "spawn claude ENOENT", effective: { strong: null, fast: null } });
    src.plan.push(new Error("still missing"));
    await expect(settings.catalog()).rejects.toThrow("still missing");
    // a fixed selection is still passed on without a list
    settings.select("fast", { mode: "fixed", model: "haiku" });
    src.plan.push(new Error("still missing"));
    expect(await settings.resolve("fast")).toEqual({ model: "haiku" });
  });

  it("firstFetchWaitMs: a hanging first fetch does not hold a Run beyond the wait, and is not asked twice", async () => {
    const { settings, src } = setup({ firstFetchWaitMs: 40 });
    const hanging = deferred<CliModelCatalog>();
    src.plan.push(hanging);
    const started = performance.now();
    expect(await settings.resolve("strong")).toBeUndefined();
    expect(await settings.resolve("fast")).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(src.calls).toHaveLength(1); // the second Run waited on the same request
    hanging.resolve({ engine: "claude", models: [SONNET], recommended: { model: "sonnet", effort: "high" }, fetchedAt: T0 });
    await hanging.promise;
    expect(await settings.resolve("strong")).toEqual({ model: "sonnet", effort: "high" });
    expect(src.calls).toHaveLength(1);
  });

  it("warm() starts the first fetch once", async () => {
    const { settings, src } = setup();
    settings.warm();
    settings.warm();
    expect(src.calls).toEqual(["claude"]);
    await settings.catalog();
    settings.warm();
    expect(src.calls).toHaveLength(1);
  });
});
