import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { createKernel, type Kernel, type KernelOptions } from "@ng/cell";
import { UiChannel } from "@ng/channel";
import { createBus, createRegistry, DESK_CELL_ID, OWNER_PRINCIPAL, systemClock, type Channel, type CliEngine, type Clock, type Registry } from "@ng/protocol";
import { registerPresets, seedBuiltinSkills } from "@ng/presets";
import type { Hono } from "hono";
import { createAgentControlPlane } from "../agent/tools";
import { createDeskApp } from "./app";
import { selectBackend, type Env } from "./backend";
import { createDesk, type Desk } from "./desk";
import { createEventHub, type EventHub } from "./events";
import { DEFAULT_SETTINGS, type DeskSettings } from "./projections/common";
import { ARTIFACT_EDITOR_PREFIX } from "./projections/format";
import { securityPolicyFor, type SecurityPolicy } from "./security";

export const DEFAULT_PORT = 8790;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface DeskServerOptions {
  /** Configuration source (default process.env). */
  env?: Env;
  dataDir?: string;
  /** Default NG_DESK_HOST, else 127.0.0.1. */
  host?: string;
  /** Default NG_DESK_PORT, else 8790 (0 = any free port). */
  port?: number;
  /** Extra Host header names accepted; on a non-loopback bind, the only ones besides loopback. Default NG_DESK_ALLOWED_HOSTS. */
  allowedHosts?: string[];
  /** Is this CLI agent installed? Default: `<bin> --version` runs (tests inject a fake). */
  detectCli?: (engine: CliEngine, bin: string) => boolean;
  clock?: Clock;
  /** Channels besides `ui` and the ones configured from the environment (e.g. a MemoryChannel in tests). */
  channels?: Channel[];
  /** Default `registerPresets` from @ng/presets. */
  registerPresets?: (registry: Registry, opts: { deskCellId: string; timeZone?: string }) => unknown;
  /** Passed through to createKernel (after everything boot sets). */
  kernel?: Partial<KernelOptions>;
  /** Built web client; default <app>/dist/web; null = API only. */
  webDir?: string | null;
  settings?: Partial<Pick<DeskSettings, "weeklyReview">>;
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

function portOf(v: string | undefined): number {
  if (v === undefined || v === "") return DEFAULT_PORT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`NG_DESK_PORT must be a port number, got "${v}"`);
  return n;
}

/**
 * registry → presets → kernel and workbench channel → desk root cell → start → HTTP app.
 */
export async function createDeskServer(opts: DeskServerOptions = {}): Promise<DeskServer> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(`[desk] ${line}`));
  const onError = opts.onError ?? ((err: unknown, where: string) => console.error(`[desk] ${where}:`, err));
  const host = opts.host ?? (env["NG_DESK_HOST"] || "127.0.0.1");
  const port = opts.port ?? portOf(env["NG_DESK_PORT"]);
  const security = securityPolicyFor(host, opts.allowedHosts ?? csv(env["NG_DESK_ALLOWED_HOSTS"]));

  const timeZone = env["NG_DESK_TZ"] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const choice = selectBackend(env, {
    ...(opts.detectCli ? { detect: opts.detectCli } : {}),
  });
  const dataDir = resolve(opts.dataDir ?? (env["NG_DESK_DATA_DIR"] || "./data"));
  const clock = opts.clock ?? systemClock;
  mkdirSync(dataDir, { recursive: true });

  const bus = opts.kernel?.bus ?? createBus({ onError: (err, topic) => onError(err, `bus handler for ${topic}`) });
  const ownerPrincipal = opts.kernel?.ownerPrincipal ?? OWNER_PRINCIPAL;
  const deskCellId = opts.kernel?.deskCellId ?? DESK_CELL_ID;

  {
    // What a CLI agent refused or why it failed belongs in the server log; launches only on request.
    const verbose = env["NG_CLI_DEBUG"] === "1";
    for (const [engine, engineOpts] of Object.entries(choice.kernelOptions.cli ?? {})) {
      engineOpts.onDebug = (e) => {
        if (e.type === "notice") log(`${engine} [${e.cellId}] ${e.text}`);
        else if (e.type === "exit" && ((e.code !== 0 && !e.stopped) || verbose)) log(`${engine} [${e.cellId}] exited ${e.code ?? e.signal}${e.stderr.trim() ? `: ${e.stderr.trim().slice(-500)}` : ""}`);
        else if (e.type === "launch" && verbose) log(`${engine} [${e.cellId}] ${e.argv.join(" ")} (cwd ${e.cwd}) — ${e.permissions}`);
      };
    }
  }
  const registry = opts.kernel?.registry ?? createRegistry();
  (opts.registerPresets ?? (registerPresets as NonNullable<DeskServerOptions["registerPresets"]>))(registry, { deskCellId, timeZone });
  // Who saved a document's current version is the app's record (format.ts), not something a cell may write.
  registry.reserveState([], [ARTIFACT_EDITOR_PREFIX]);

  const ui = new UiChannel({ clock, ownerPrincipal });
  const kernel = createKernel({
    dataDir,
    clock,
    bus,
    registry,
    ownerPrincipal,
    deskCellId,
    channels: [ui, ...(opts.channels ?? [])],
    onError,
    // With a CLI agent behind the cells, the owner picks its model in the workbench; the list comes from the CLI.
    modelSwitch: true,
    cliRunners: choice.runners,
    ...choice.kernelOptions,
    ...opts.kernel,
  });

  let events: EventHub | undefined;
  try {
    kernel.ensureRootCell({ id: deskCellId, preset: "inline", title: "主台" }, {principalId: kernel.ownerPrincipal});
    // The playbooks the presets' prompts refer to (an owner-edited SKILL.md of the same name is kept).
    const seeded = seedBuiltinSkills(kernel.context, deskCellId);
    if (seeded.length) log(`installed built-in skills: ${seeded.join(", ")}`);
    await kernel.start();
    const settings: DeskSettings = {
      ...DEFAULT_SETTINGS,
      timeZone,
      ...opts.settings,
      backend: kernel.agentBackend ?? choice.engine,
    };
    const desk = createDesk({ kernel, ui, settings, onError });
    events = createEventHub(kernel);
    const webDir = opts.webDir === undefined ? resolve(APP_ROOT, "dist/web") : opts.webDir;
    const agent = createAgentControlPlane({ kernel, desk });
    const app = createDeskApp({ desk, events, security, agent, webDir, onError });
    log(`data ${dataDir} · default runner: ${kernel.agentBackend} · enabled runners: ${kernel.cliRunners.join(", ")}`);
    if (!security.loopback) log(`${host} is not a loopback address: everyone who can reach it operates this workbench and its agents on this machine${security.allowedHosts ? "" : " (NG_DESK_ALLOWED_HOSTS limits the Host names accepted)"}`);

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
