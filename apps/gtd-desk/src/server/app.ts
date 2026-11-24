import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { NgError } from "@ng/protocol";
import type { UpdateModelsRequest } from "../shared/api";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ActivityKind, ApiError, DeskEvent } from "../shared/api";
import { DeskError, type Desk } from "./desk";
import type { EventHub } from "./events";
import { mountAgentApi, type AgentControlPlane } from "../agent/routes";
import { crossSiteReason, hostnameOf, type SecurityPolicy } from "./security";

const MAX_BODY = 1024 * 1024;
const PING_MS = 25_000;
const ACTIVITY_KINDS = new Set<ActivityKind>(["notification_archived", "note_saved", "reminder_set", "card_withdrawn", "action_completed"]);

export interface DeskAppDeps {
  desk: Desk;
  events: EventHub;
  security: SecurityPolicy;
  /** docs/05 §5.3: the external main agent's control plane (`/api/agent/*`, also what the MCP server proxies to). */
  agent?: AgentControlPlane;
  /** Built web client (index.html + assets); null/missing = API only. */
  webDir?: string | null;
  onError?: (err: unknown, where: string) => void;
}

function apiError(c: Context, status: 400 | 403 | 404 | 409 | 413 | 415 | 500, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}

const NG_STATUS: Partial<Record<NgError["code"], 400 | 403 | 404 | 409>> = {
  invalid_argument: 400,
  not_found: 404,
  conflict: 409,
  duplicate: 409,
  stale_epoch: 409,
  bounds_violation: 403,
  unsupported: 400,
};

/** An optional non-negative integer query parameter; anything else is a 400. */
function intQuery(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new DeskError(400, "invalid_argument", `${name} 必须是非负整数`);
  return n;
}

/** JSON body or `{}` for an empty one; malformed JSON is a 400. */
async function body<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DeskError(400, "invalid_json", "请求体不是合法的 JSON");
  }
}

/**
 * The HTTP surface: `/api/*` as the owner, `/api/agent/*` as the external main agent (same rights, recorded as
 * `agent:local`), `/api/events` (SSE) and the web client. No authentication; same-site writes only.
 */
export function createDeskApp(deps: DeskAppDeps): Hono {
  const { desk, events, security } = deps;
  const ownerActor = { principalId: desk.ownerPrincipal };
  const onError = deps.onError ?? ((err, where) => console.error(`[desk] ${where}:`, err));
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DeskError) return apiError(c, err.status, err.code, err.message);
    if (err instanceof NgError) {
      const status = NG_STATUS[err.code];
      if (status) {
        const fallback = {
          400: "请求内容有误，请核对后重试",
          403: "你没有权限执行这项操作",
          404: "找不到这项内容，请刷新后再试",
          409: "内容已发生变化，请核对最新状态",
        }[status];
        return apiError(c, status, err.code, /\p{Script=Han}/u.test(err.message) ? err.message : fallback);
      }
    }
    onError(err, `${c.req.method} ${c.req.path}`);
    return apiError(c, 500, "internal_error", "服务器出错了，请稍后再试");
  });

  // ---------- guards ----------
  app.use("/api/*", async (c, next) => {
    if (security.allowedHosts) {
      const host = hostnameOf(c.req.header("host") ?? new URL(c.req.url).host);
      if (!host || !security.allowedHosts.has(host)) return apiError(c, 403, "forbidden_host", "不接受这个 Host 的请求");
    }
    const why = crossSiteReason({ method: c.req.method, url: c.req.url, header: (n) => c.req.header(n) });
    if (why) return apiError(c, why.startsWith("body") ? 415 : 403, "cross_site", `拒绝跨站请求（${why}）`);
    c.header("Cache-Control", "no-store");
    return next();
  });
  const limit = bodyLimit({ maxSize: MAX_BODY, onError: (c) => apiError(c, 413, "too_large", "请求体太大") });
  app.use("/api/*", limit);

  // ---------- top bar ----------
  app.get("/api/status", c => c.json(desk.status()));
  app.get("/api/models", async c => c.json(await desk.models(c.req.query("refresh") === "1")));
  app.put("/api/models", async c => c.json(await desk.setModel(await body<UpdateModelsRequest>(c), ownerActor)));
  app.post("/api/capture", async (c) => c.json(await desk.ingest(await body(c),ownerActor)));

  app.get("/api/projects/closed", c => c.json({projects:desk.recentlyClosedProjects()}));
  app.get("/api/human-items", c => c.json({ items: desk.listHumanItems(), openArtifactIds: desk.openArtifactIds(), questions: desk.questions().map((q) => ({ cellId: q.cellId, from: q.desk ? "主台" : (q.title ?? q.cellId), text: q.text, at: q.at, stopped: q.stopped })) }));
  app.post("/api/human-items/:id/decide", async (c) => {
    const result = await desk.decideHumanItem(c.req.param("id"), await body(c), ownerActor);
    return c.json({ ...result, deskStatus: desk.status() });
  });
  app.post("/api/human-activity/:id/undo", async (c) => {
    const result = await desk.undoHumanDecision(c.req.param("id"), ownerActor);
    return c.json({ ...result, deskStatus: desk.status() });
  });
  app.post("/api/projects/:id/reopen", async (c) => {
    const result = await desk.reopenProject(c.req.param("id"), ownerActor);
    return c.json({ ...result, deskStatus: desk.status() });
  });

  app.put("/api/human-items/:id/plan", async (c) => {
    const result = await desk.savePlan(c.req.param("id"), await body(c), ownerActor);
    return result.ok ? c.json(result) : c.json(result, 409);
  });

  // ---------- drafts ----------
  app.get("/api/artifacts/:artifactId", (c) => c.json(desk.artifact(c.req.param("artifactId"))));
  app.put("/api/artifacts/:artifactId", async (c) => {
    const r = desk.saveArtifact(c.req.param("artifactId"), await body(c),ownerActor);
    return c.json(r, r.ok ? 200 : 409);
  });
  app.post("/api/artifacts/:artifactId/parked/:parkedId/dismiss", (c) => c.json(desk.dismissParked(c.req.param("artifactId"), c.req.param("parkedId"),ownerActor)));

  // ---------- 🧭 Radar ----------
  app.get("/api/radar", (c) => c.json(desk.radar()));
  for (const op of ["pause", "resume", "cancel", "complete", "someday", "activate"] as const) {
    app.post(`/api/projects/:projectId/${op}`, async (c) => c.json(await desk.projectOp(c.req.param("projectId"), op, ownerActor)));
  }
  app.post("/api/projects/:projectId/actions", async (c) => c.json(await desk.addProjectAction(c.req.param("projectId"), await body(c), ownerActor)));

  // ---------- 分身实况 Agents ----------
  app.get("/api/agents/topology", (c) => {
    const archived = c.req.query("includeArchived");
    if (archived !== undefined && archived !== "0" && archived !== "1") throw new DeskError(400, "invalid_argument", "includeArchived 只能是 0 或 1");
    return c.json(desk.topology({ includeArchived: archived === "1", projectId: c.req.query("projectId") || null }));
  });
  app.get("/api/cells/:cellId/timeline", (c) => {
    const afterSeq = intQuery(c, "afterSeq");
    const beforeSeq = intQuery(c, "beforeSeq");
    const limit = intQuery(c, "limit");
    if (limit === 0) throw new DeskError(400, "invalid_argument", "limit 必须是正整数");
    return c.json(desk.timeline(c.req.param("cellId"), { ...(afterSeq !== undefined ? { afterSeq } : {}), ...(beforeSeq !== undefined ? { beforeSeq } : {}), ...(limit !== undefined ? { limit } : {}) }));
  });
  app.get("/api/resources", (c) => c.json(desk.resource(c.req.query("uri") ?? "", intQuery(c, "offset") ?? 0, intQuery(c, "limit") ?? undefined, c.req.query("cellId") || undefined)));
  app.post("/api/cells/:cellId/messages", async (c) => c.json(desk.sendCellMessage(c.req.param("cellId"), await body(c), ownerActor)));
  app.post("/api/cells/:cellId/control", async (c) => c.json(await desk.cellControl(c.req.param("cellId"), await body(c), ownerActor)));
  app.post("/api/cells/:cellId/trigger", (c) => c.json(desk.cellTrigger(c.req.param("cellId"), ownerActor)));

  // ---------- weekly review ----------
  app.get("/api/review", (c) => c.json(desk.review()));
  app.post("/api/review/skills/:name/accept", (c) => c.json(desk.acceptSkill(c.req.param("name"),ownerActor)));
  app.post("/api/review/skills/:name/dismiss", (c) => c.json(desk.dismissSkill(c.req.param("name"),ownerActor)));
  app.post("/api/review/sensors/:sensorId/code", async (c) => c.json(desk.sensorToCode(c.req.param("sensorId"), await body(c),ownerActor)));

  // ---------- activity drawer ----------
  app.get("/api/activity", (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && !ACTIVITY_KINDS.has(kind as ActivityKind)) throw new DeskError(400, "invalid_argument", `未知的记录类型 ${kind}`);
    return c.json(desk.activity(kind as ActivityKind | undefined));
  });
  app.post("/api/activity/:cellId/:activityId/restore", async (c) => c.json(await desk.restoreActivity(c.req.param("cellId"), c.req.param("activityId"),ownerActor)));

  // ---------- ⚡ 信源 ----------
  app.get("/api/sources", (c) => c.json(desk.sources()));
  app.post("/api/sources", async (c) => c.json(desk.createSource(await body(c),ownerActor)));
  app.post("/api/sources/:sensorId/pause", (c) => c.json(desk.pauseSource(c.req.param("sensorId"), true,ownerActor)));
  app.post("/api/sources/:sensorId/resume", (c) => c.json(desk.pauseSource(c.req.param("sensorId"), false,ownerActor)));
  app.put("/api/sources/:sensorId/mode", async (c) => c.json(desk.setSourceMode(c.req.param("sensorId"), await body(c),ownerActor)));
  app.delete("/api/sources/:sensorId", async (c) => c.json(await desk.deleteSource(c.req.param("sensorId"),ownerActor)));

  // ---------- live updates ----------
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const write = (e: DeskEvent) => stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }).catch(() => undefined);
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      const unsubscribe = events.subscribe((e) => void write(e));
      const unClose = events.onClose(() => done());
      const ping = setInterval(() => void write({ event: "ping", data: {} }), PING_MS);
      stream.onAbort(() => done());
      try {
        await write({ event: "hello", data: { status: desk.status() } });
        await finished;
      } finally {
        clearInterval(ping);
        unsubscribe();
        unClose();
      }
    }),
  );

  // ---------- external main agent ----------
  if (deps.agent) mountAgentApi(app, deps.agent);

  app.all("/api/*", (c) => apiError(c, 404, "not_found", "没有这个接口"));

  // ---------- web client ----------
  const webDir = deps.webDir && existsSync(join(deps.webDir, "index.html")) ? deps.webDir : null;
  if (webDir) {
    app.use("/*", serveStatic({ root: webDir }));
    const index = () => readFileSync(join(webDir, "index.html"), "utf8");
    app.get("*", (c) => c.html(index()));
  } else {
    app.get("/", (c) =>
      c.text("GTD 工作台的界面还没有构建（pnpm --filter @ng/gtd-desk build:web）。接口可用：/api/status\n", 200, { "Content-Type": "text/plain; charset=utf-8" }),
    );
  }
  return app;
}
