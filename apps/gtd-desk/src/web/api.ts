import { captureAssetId, isImageType, MAX_SAVED_IMAGE_BYTES, type CaptureImageUpload, type SavedCaptureImage, type CaptureImageData } from "../shared/capture-assets";
import type { ClosedProjectsResponse, HumanItemsResponse, HumanDecisionRequest, HumanDecisionResponse, UndoResponse, PlanSaveRequest, PlanSaveResponse } from "../shared/api";
import type {
  ActivityKind,
  ActivityListDTO,
  ActivityMutationResponse,
  ApiError,
  ArtifactDTO,
  ArtifactSaveRequest,
  ArtifactSaveResponse,
  ButtonDTO,
  CaptureRequest,
  CaptureResponse,
  CellTimelineDTO,
  CreateSourceRequest,
  HttpMethod,
  ModelsDTO,
  RadarDTO,
  ResourcePageDTO,
  SendCellMessageRequest,
  SendCellMessageResponse,
  SourcesDTO,
  UpdateModelsRequest,
  SourcesMutationResponse,
  StatusDTO,
  TopologyDTO,
  WeeklyReviewDTO,
} from "../shared/api";

/** A failed request, with the server's own message when it sent one. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && typeof (v as ApiError).error?.message === "string";
}

/** Result bodies (they carry an `outcome`) are returned even on 409: the version-protected saves answer that way. */
function isResultBody(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as { outcome?: unknown }).outcome === "string";
}

export async function request<T>(method: HttpMethod, path: string, body?: unknown, opts: { keepalive?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (method !== "GET") {
    // Writes always carry a JSON body: the server refuses non-JSON bodies as a cross-site guard.
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  if (opts.keepalive) init.keepalive = true;
  if (opts.signal) { opts.signal.throwIfAborted(); init.signal = opts.signal; }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiFailure(0, "network", "连不上工作台服务：请检查服务是否在运行、网络是否正常");
  }
  opts.signal?.throwIfAborted();
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (res.ok) return json as T;
  if (isResultBody(json)) return json as T;
  if (isApiError(json)) throw new ApiFailure(res.status, json.error.code, json.error.message);
  throw new ApiFailure(res.status, "http", `服务返回了错误（HTTP ${res.status}）`);
}

/** Sends what a ButtonDTO describes, merging the collected input into its pre-filled body. */
export function callButton<T = unknown>(button: ButtonDTO, extra: Record<string, unknown> = {}): Promise<T> {
  const ep = button.endpoint;
  if (!ep) return Promise.reject(new ApiFailure(0, "client", "这个按钮没有对应的操作"));
  return request<T>(ep.method, ep.path, { ...(ep.body ?? {}), ...extra });
}

const enc = encodeURIComponent;

const MAX_IMAGE_REQUEST_BYTES = 256 * 1024 - 1024;
let imageReads = 0;
const imageReadWaiters: Array<() => void> = [];
async function acquireImageRead(signal: AbortSignal) {
  signal.throwIfAborted();
  if (imageReads < 2) { imageReads++; return; }
  if (imageReadWaiters.length >= 16) throw Error("Image preview is busy");
  await new Promise<void>((resolve, reject) => {
    const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { const i = imageReadWaiters.indexOf(ready); if (i >= 0) imageReadWaiters.splice(i, 1); reject(new DOMException("Aborted", "AbortError")); };
    imageReadWaiters.push(ready); signal.addEventListener("abort", abort, { once: true });
  });
}
function releaseImageRead() { const next = imageReadWaiters.shift(); if (next) next(); else imageReads--; }

export const api = {
  status: () => request<StatusDTO>("GET", "/api/status"),
  saveCaptureImage: async (value: CaptureImageUpload, signal: AbortSignal) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length >= MAX_IMAGE_REQUEST_BYTES) throw Error("Image payload exceeds the request budget");
    const saved = await request<SavedCaptureImage>("POST", "/api/capture-assets", value, { signal });
    if (typeof saved.uri !== "string" || !captureAssetId(saved.uri) || saved.label !== value.label ||
        saved.contentType !== value.contentType || saved.width !== value.width || saved.height !== value.height ||
        !Number.isInteger(saved.bytes) || saved.bytes < 1 || saved.bytes > MAX_SAVED_IMAGE_BYTES) throw Error("Incomplete image receipt");
    return saved;
  },
  readCaptureImage: async (uri: string, signal: AbortSignal) => {
    const id = captureAssetId(uri);
    if (!id) throw Error("Invalid image reference");
    await acquireImageRead(signal);
    try {
      const data = await request<CaptureImageData>("GET", "/api/capture-assets/" + id, undefined, { signal });
      signal.throwIfAborted();
      if (!Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width < 1 || data.height < 1 || Math.max(data.width, data.height) > 2048) throw Error("Incomplete image metadata");
      if (!isImageType(data.contentType) || !data.dataBase64 || data.dataBase64.length > Math.ceil(MAX_SAVED_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.dataBase64)) throw Error("Invalid image response");
      const raw = atob(data.dataBase64);
      if (!raw.length || raw.length !== data.bytes || raw.length > MAX_SAVED_IMAGE_BYTES) throw Error("Incomplete image response");
      return new Blob([Uint8Array.from(raw, c => c.charCodeAt(0))], { type: data.contentType });
    } finally { releaseImageRead(); }
  },
  capture: (req: CaptureRequest) => request<CaptureResponse>("POST", "/api/capture", req),
  /** The CLI agent's models; `refresh` asks the CLI again instead of using the cached list. */
  models: (refresh = false) => request<ModelsDTO>("GET", refresh ? "/api/models?refresh=1" : "/api/models"),
  setModel: (req: UpdateModelsRequest) => request<ModelsDTO>("PUT", "/api/models", req),



  humanItems: () => request<HumanItemsResponse>("GET", "/api/human-items"),
  decide: (id: string, d: HumanDecisionRequest) => request<HumanDecisionResponse>("POST", `/api/human-items/${enc(id)}/decide`, d),
  undo: (id: string) => request<UndoResponse>("POST", `/api/human-activity/${enc(id)}/undo`),
  closedProjects: () => request<ClosedProjectsResponse>("GET", "/api/projects/closed"),
  reopen: (id: string) => request<{deskStatus: StatusDTO}>("POST", `/api/projects/${enc(id)}/reopen`),
  savePlan: (id: string, plan: PlanSaveRequest) => request<PlanSaveResponse>("PUT", `/api/human-items/${enc(id)}/plan`, plan),
  artifact: (artifactId: string) => request<ArtifactDTO>("GET", `/api/artifacts/${enc(artifactId)}`),
  saveArtifact: (save: ArtifactDTO["save"], req: ArtifactSaveRequest) => request<ArtifactSaveResponse>(save.method, save.path, req),

  radar: () => request<RadarDTO>("GET", "/api/radar"),
  review: () => request<WeeklyReviewDTO>("GET", "/api/review"),

  activity: (kind?: ActivityKind) => request<ActivityListDTO>("GET", kind ? `/api/activity?kind=${enc(kind)}` : "/api/activity"),
  restoreActivity: (button: ButtonDTO) => callButton<ActivityMutationResponse>(button),

  sources: () => request<SourcesDTO>("GET", "/api/sources"),
  createSource: (req: CreateSourceRequest) => request<SourcesMutationResponse>("POST", "/api/sources", req),

  topology: (opts: { includeArchived: boolean; projectId?: string | undefined }) =>
    request<TopologyDTO>("GET", `/api/agents/topology?includeArchived=${opts.includeArchived ? 1 : 0}${opts.projectId ? `&projectId=${enc(opts.projectId)}` : ""}`),
  /** No range = the newest page; `afterSeq` = only what came after it; `beforeSeq` = the page before it. */
  timeline: (cellId: string, range: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (range.afterSeq !== undefined) q.set("afterSeq", String(range.afterSeq));
    if (range.beforeSeq !== undefined) q.set("beforeSeq", String(range.beforeSeq));
    if (range.limit !== undefined) q.set("limit", String(range.limit));
    const qs = q.toString();
    return request<CellTimelineDTO>("GET", `/api/cells/${enc(cellId)}/timeline${qs ? `?${qs}` : ""}`);
  },
  resource: (uri: string, offset: number, limit: number) => request<ResourcePageDTO>("GET", `/api/resources?uri=${enc(uri)}&offset=${offset}&limit=${limit}`),
  sendCellMessage: (cellId: string, req: SendCellMessageRequest) => request<SendCellMessageResponse>("POST", `/api/cells/${enc(cellId)}/messages`, req),
};
