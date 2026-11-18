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
  ClarifyQueueDTO,
  CreateSourceRequest,
  Effort,
  EngageDetailDTO,
  EngageListDTO,
  FocusResponse,
  HttpMethod,
  ModelsDTO,
  RadarDTO,
  SourcesDTO,
  SetModelRequest,
  SourcesMutationResponse,
  StatusDTO,
  WeeklyReviewDTO,
} from "../shared/api";

const TOKEN_KEY = "ng-desk-token";

let token: string | null = null;

/**
 * Reads `#token=…` once (then removes it from the address bar so it is not bookmarked or shared), falling back to
 * this tab's sessionStorage. The token never goes into localStorage.
 */
export function initToken(): void {
  const m = /(?:^#|[#&])token=([^&]+)/.exec(window.location.hash);
  if (m?.[1]) {
    token = decodeURIComponent(m[1]);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // storage can be unavailable (private mode); the in-memory copy still works for this page
    }
    const rest = window.location.hash.replace(/(?:^#|[#&])token=[^&]+&?/, "#").replace(/^#$/, "");
    history.replaceState(null, "", window.location.pathname + window.location.search + rest);
    return;
  }
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
}

export function setToken(value: string): void {
  token = value.trim() || null;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // see initToken
  }
}

export function hasToken(): boolean {
  return token !== null;
}

/** The SSE stream cannot carry headers, so the token rides on the query string there (and only there). */
export function eventsUrl(): string {
  return token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
}

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

  get unauthorized(): boolean {
    return this.status === 401;
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && typeof (v as ApiError).error?.message === "string";
}

/** Result bodies (they carry an `outcome`) are returned even on 409: the version-protected saves answer that way. */
function isResultBody(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as { outcome?: unknown }).outcome === "string";
}

export async function request<T>(method: HttpMethod, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (method !== "GET") {
    // Writes always carry a JSON body: the server refuses non-JSON bodies as a cross-site guard.
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  if (opts.keepalive) init.keepalive = true;
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiFailure(0, "network", "连不上工作台服务：请检查服务是否在运行、网络是否正常");
  }
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

export const api = {
  status: () => request<StatusDTO>("GET", "/api/status"),
  capture: (req: CaptureRequest) => request<CaptureResponse>("POST", "/api/capture", req),
  focus: (on: boolean, keepalive = false) => request<FocusResponse>("POST", "/api/focus", { on }, { keepalive }),
  /** The CLI agent's models; `refresh` asks the CLI again instead of using the cached list. */
  models: (refresh = false) => request<ModelsDTO>("GET", refresh ? "/api/models?refresh=1" : "/api/models"),
  setModel: (req: SetModelRequest) => request<ModelsDTO>("PUT", "/api/models", req),

  clarify: () => request<ClarifyQueueDTO>("GET", "/api/clarify"),

  engage: (effort: Effort | "all") => request<EngageListDTO>("GET", effort === "all" ? "/api/engage" : `/api/engage?effort=${enc(effort)}`),
  engageDetail: (cellId: string, actionId: string) => request<EngageDetailDTO>("GET", `/api/engage/${enc(cellId)}/${enc(actionId)}`),

  artifact: (artifactId: string) => request<ArtifactDTO>("GET", `/api/artifacts/${enc(artifactId)}`),
  saveArtifact: (save: ArtifactDTO["save"], req: ArtifactSaveRequest) => request<ArtifactSaveResponse>(save.method, save.path, req),

  radar: () => request<RadarDTO>("GET", "/api/radar"),
  review: () => request<WeeklyReviewDTO>("GET", "/api/review"),

  activity: (kind?: ActivityKind) => request<ActivityListDTO>("GET", kind ? `/api/activity?kind=${enc(kind)}` : "/api/activity"),
  restoreActivity: (button: ButtonDTO) => callButton<ActivityMutationResponse>(button),

  sources: () => request<SourcesDTO>("GET", "/api/sources"),
  createSource: (req: CreateSourceRequest) => request<SourcesMutationResponse>("POST", "/api/sources", req),
};
