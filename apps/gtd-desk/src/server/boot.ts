import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { createKernel, type Kernel, type KernelOptions } from "@ng/cell";
import { UiChannel } from "@ng/channel";
import { envSecretStore, type SecretStore } from "@ng/gate";
import { createBus, createRegistry, DESK_CELL_ID, OWNER_PRINCIPAL, systemClock, type Channel, type CliEngine, type Clock, type ModelClient, type Registry } from "@ng/protocol";
import { registerPresets, seedBuiltinSkills } from "@ng/presets";
import type { Hono } from "hono";
import { createAgentControlPlane } from "../agent/tools";
import { createDeskApp } from "./app";
import { selectBackend, type Env } from "./backend";
import { channelsFromEnv } from "./channels";
import { createDemoMode, type DemoMode } from "./demo";
import { createDesk, type Desk } from "./desk";
import { createEventHub, type EventHub } from "./events";
import { DEFAULT_SETTINGS, type DeskSettings } from "./projections/common";
import { agentTokensFromEnv, securityPolicyFor, type SecurityPolicy } from "./security";
import { createModelSwitch } from "./models";

export const DEFAULT_PORT = 8790;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface DeskServerOptions {
  /** Configuration source (default process.env). */
  env?: Env;
  /** Default NG_DESK_DATA_DIR, else ./data (./data-demo in demo mode, so demo content never mixes with real data). */
  dataDir?: string;
  /** Default NG_DESK_HOST, else 127.0.0.1. */
  host?: string;
  /** Default NG_DESK_PORT, else 8790 (0 = any free port). */
  port?: number;
  /** Bearer token for /api/*; default NG_DESK_TOKEN. Required for a non-loopback host. */
  token?: string | null;
  /** Extra Host header names accepted on a loopback bind; default NG_DESK_ALLOWED_HOSTS. */
  allowedHosts?: string[];
  /** External main agents allowed on `/api/agent/*`: agent id → bearer token. Default NG_AGENT_TOKEN / NG_AGENT_TOKENS. */
  agentTokens?: Record<string, string>;
  /**
   * The owner's budget-limits switch at start: false = no cell is stopped for its budget. Default NG_BUDGET_LIMITS
   * (`off` / `0` / `false`, `on` / `1` / `true`); unset = the choice last made in the workbench applies (default on).
   */
  budgetLimits?: boolean;
  /** Explicit model; wins over the environment (tests, embedding). */
  model?: ModelClient;
  /** Demo seam: the model and seed used when no model is configured (default ./demo.ts createDemoMode()). */
  demo?: DemoMode;
  /** Is this CLI agent installed? Default: `<bin> --version` runs (tests inject a fake). */
  detectCli?: (engine: CliEngine, bin: string) => boolean;
  clock?: Clock;
  /** Channels besides `ui` and the ones configured from the environment (e.g. a MemoryChannel in tests). */
  channels?: Channel[];
  /** Secret store shared by the kernel and the channels; default `NG_SECRET_<REF>` from `env`. */
  secrets?: SecretStore;
  /** Default `registerPresets` from @ng/presets. */
  registerPresets?: (registry: Registry, opts: { deskCellId: string; ownerAddress: `channel:${string}:${string}`; timeZone?: string }) => unknown;
  /** Passed through to createKernel (after everything boot sets). */
  kernel?: Partial<KernelOptions>;
  /** Built web client; default <app>/dist/web; null = API only. */
  webDir?: string | null;
  settings?: Partial<Pick<DeskSettings, "weeklyReview" | "snoozeAfternoonHour">>;
  log?: (line: string) => void;
  onError?: (err: unknown, where: string) => void;
}

export interface DeskServer {
  readonly app: Hono;
  readonly kernel: Kernel;
  readonly desk: Desk;
  readonly ui: UiChannel;
  readonly events: EventHub;
  readonly settings: DeskSettings;
  readonly security: SecurityPolicy;
  readonly host: string;
  readonly port: number;
  /** Binds the HTTP server; resolves with the bound address. */
  listen(): Promise<{ url: string; host: string; port: number }>;
  /** Stops accepting requests, ends SSE streams, stops the kernel and closes the database. Idempotent. */
  close(): Promise<void>;
}

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** NG_BUDGET_LIMITS: `off`/`0`/`false` → false, `on`/`1`/`true` → true, unset/empty → undefined (the stored choice). */
export function budgetLimitsFromEnv(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (s === "off" || s === "0" || s === "false") return false;
  if (s === "on" || s === "1" || s === "true") return true;
  throw new Error(`NG_BUDGET_LIMITS must be on or off, got "${v}"`);
}

function portOf(v: string | undefined): number {
  if (v === undefined || v === "") return DEFAULT_PORT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`NG_DESK_PORT must be a port number, got "${v}"`);
  return n;
}

/**
 * registry → presets → kernel (ui + configured channels) → desk root cell → start → (demo seed) → HTTP app.
 * Fails before touching the data directory when the bind would be unsafe.
 */
export async function createDeskServer(opts: DeskServerOptions = {}): Promise<DeskServer> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(`[desk] ${line}`));
  const onError = opts.onError ?? ((err: unknown, where: string) => console.error(`[desk] ${where}:`, err));
  const host = opts.host ?? (env["NG_DESK_HOST"] || "127.0.0.1");
  const port = opts.port ?? portOf(env["NG_DESK_PORT"]);
  const token = opts.token !== undefined ? opts.token : (env["NG_DESK_TOKEN"] ?? null);
  const security = securityPolicyFor(host, token, opts.allowedHosts ?? csv(env["NG_DESK_ALLOWED_HOSTS"]), opts.agentTokens ?? agentTokensFromEnv(env));

  const budgetLimits = opts.budgetLimits ?? budgetLimitsFromEnv(env["NG_BUDGET_LIMITS"]);
  const timeZone = env["NG_DESK_TZ"] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const demoMode = opts.demo ?? createDemoMode({ timeZone });
  const choice = selectBackend(env, {
    ...(opts.model ? { model: opts.model } : {}),
    demoModel: () => demoMode.model(),
    ...(opts.detectCli ? { detect: opts.detectCli } : {}),
  });
  const dataDir = resolve(opts.dataDir ?? (env["NG_DESK_DATA_DIR"] || (choice.demo ? "./data-demo" : "./data")));
  // Decided before the database is opened: a demo seed replays its scenarios from a few days ago.
  const clock = opts.clock ?? (choice.demo && demoMode.clock ? demoMode.clock(dataDir) : systemClock);
  mkdirSync(dataDir, { recursive: true });

  const bus = opts.kernel?.bus ?? createBus({ onError: (err, topic) => onError(err, `bus handler for ${topic}`) });
  const secrets = opts.secrets ?? envSecretStore({ env });
  const ownerPrincipal = opts.kernel?.ownerPrincipal ?? OWNER_PRINCIPAL;
  const deskCellId = opts.kernel?.deskCellId ?? DESK_CELL_ID;
  const ownerAddresses = opts.kernel?.ownerAddresses ?? (csv(env["NG_OWNER_ADDRESSES"]).length ? ["channel:ui:*", "channel:cli:*", ...csv(env["NG_OWNER_ADDRESSES"])] : undefined);

  if (choice.engine !== "api" && choice.engine !== "demo") {
    // What a CLI agent refused or why it failed belongs in the server log; launches only on request.
    const verbose = env["NG_CLI_DEBUG"] === "1";
    const engineOpts = choice.kernelOptions.cli?.[choice.engine];
    if (engineOpts) {
      engineOpts.onDebug = (e) => {
        if (e.type === "notice") log(`${choice.engine} [${e.cellId}] ${e.text}`);
        else if (e.type === "exit" && (e.code !== 0 || verbose)) log(`${choice.engine} [${e.cellId}] exited ${e.code ?? e.signal}${e.stderr.trim() ? `: ${e.stderr.trim().slice(-500)}` : ""}`);
        else if (e.type === "launch" && verbose) log(`${choice.engine} [${e.cellId}] ${e.argv.join(" ")} (cwd ${e.cwd}) — ${e.permissions}`);
      };
    }
  }
  const registry = opts.kernel?.registry ?? createRegistry();
  (opts.registerPresets ?? (registerPresets as NonNullable<DeskServerOptions["registerPresets"]>))(registry, { deskCellId, ownerAddress: "channel:ui:owner", timeZone });
  if (choice.demo) demoMode.setup?.(registry);

  const ui = new UiChannel({ clock, bus, ownerPrincipal });
  const external = channelsFromEnv(env, secrets, clock, ownerPrincipal);
  const kernel = createKernel({
    dataDir,
    clock,
    bus,
    registry,
    secrets,
    ownerPrincipal,
    deskCellId,
    ...(ownerAddresses ? { ownerAddresses } : {}),
    channels: [ui, ...external.channels, ...(choice.demo && demoMode.channels ? demoMode.channels(clock) : []), ...(opts.channels ?? [])],
    onError,
    // With a CLI agent behind the cells, the owner picks its model in the workbench; the list comes from the CLI.
    ...(choice.engine !== "api" && choice.engine !== "demo" ? { modelSwitch: true } : {}),
    ...(budgetLimits !== undefined ? { budgetLimits } : {}),
    ...choice.kernelOptions,
    ...opts.kernel,
  });

  let events: EventHub | undefined;
  try {
    const fresh = kernel.getCell(deskCellId) === undefined;
    kernel.ensureRootCell({ id: deskCellId, preset: "inline", title: "主台" });
    // The playbooks the presets' prompts refer to (an owner-edited SKILL.md of the same name is kept).
    const seeded = seedBuiltinSkills(kernel.context, deskCellId);
    if (seeded.length) log(`installed built-in skills: ${seeded.join(", ")}`);
    await kernel.start();
    const settings: DeskSettings = {
      ...DEFAULT_SETTINGS,
      ...opts.settings,
      demo: choice.demo,
      backend: choice.backend,
      tokenRequired: security.token !== null,
    };
    const desk = createDesk({ kernel, ui, settings, onError });
    if (choice.demo && demoMode.seed) {
      try {
        await demoMode.seed({ kernel, ui, desk, clock, dataDir, fresh, log });
      } catch (err) {
        // A broken demo story must not keep the workbench from starting.
        onError(err, "demo seed");
      }
    }
    events = createEventHub(kernel);
    const webDir = opts.webDir === undefined ? resolve(APP_ROOT, "dist/web") : opts.webDir;
    const agent = createAgentControlPlane({ kernel, desk, ui, settings });
    const app = createDeskApp({ desk, hub: kernel.hub, events, security, agent, models: createModelSwitch(kernel), webDir, onError });
    const agentAccess =
      security.agentTokens.size > 0
        ? `token for ${[...security.agentTokens.keys()].map((id) => `agent:${id}`).join(", ")}`
        : security.loopback && security.token === null
          ? "open on loopback as agent:local"
          : "closed (set NG_AGENT_TOKEN)";
    log(
      `data ${dataDir} · agents: ${choice.backend}${choice.demo ? " (demo mode)" : ""} — ${choice.reason} · channels: ui${choice.demo ? ", demo" : ""}${external.summary.length ? `, ${external.summary.join(", ")}` : ""} · main-agent API /api/agent/* (MCP: bin/ng-mcp.mjs): ${agentAccess}`,
    );

    let server: ServerType | null = null;
    let closing: Promise<void> | null = null;
    const hub = events;
    return {
      app,
      kernel,
      desk,
      ui,
      events: hub,
      settings,
      security,
      host,
      port,
      listen() {
        if (server) throw new Error("already listening");
        return new Promise((resolveListen, reject) => {
          const s = serve({ fetch: app.fetch, hostname: host, port }, (info: AddressInfo) => {
            const shown = info.address.includes(":") ? `[${info.address}]` : info.address;
            resolveListen({ url: `http://${shown}:${info.port}`, host: info.address, port: info.port });
          });
          s.once("error", reject);
          server = s;
        });
      },
      close() {
        closing ??= (async () => {
          hub.close();
          if (server) {
            const s = server;
            await new Promise<void>((r) => s.close(() => r()));
          }
          await kernel.close();
        })();
        return closing;
      },
    };
  } catch (err) {
    events?.close();
    await kernel.close().catch(() => undefined);
    throw err;
  }
}
