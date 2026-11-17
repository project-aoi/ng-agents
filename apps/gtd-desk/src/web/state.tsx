import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StatusDTO, ViewName } from "../shared/api";
import { ApiFailure } from "./api";

// ==================== top-bar status ====================
// Every mutation answers with the refreshed top bar; views hand it up through this sink.

interface StatusApi {
  status: StatusDTO | null;
  setStatus(s: StatusDTO): void;
}

const StatusContext = createContext<StatusApi>({ status: null, setStatus: () => undefined });

export const StatusProvider = StatusContext.Provider;

export function useStatus(): StatusApi {
  return useContext(StatusContext);
}

// Per-view fetch + SSE invalidation: each mounted view owns its data; a `refresh {views}` event bumps a counter per
// view name and the views that depend on it refetch. Nothing else is shared, so there is no global store.

// ==================== refresh ticks ====================

type Ticks = Readonly<Record<ViewName, number>>;

const ZERO: Ticks = { clarify: 0, engage: 0, radar: 0, review: 0, status: 0, sources: 0, activity: 0 };

interface RefreshApi {
  ticks: Ticks;
  bump(views: readonly ViewName[]): void;
}

const RefreshContext = createContext<RefreshApi>({ ticks: ZERO, bump: () => undefined });

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [ticks, setTicks] = useState<Ticks>(ZERO);
  const bump = useCallback((views: readonly ViewName[]) => {
    if (views.length === 0) return;
    setTicks((t) => {
      const next = { ...t };
      for (const v of views) next[v] = (next[v] ?? 0) + 1;
      return next;
    });
  }, []);
  const value = useMemo(() => ({ ticks, bump }), [ticks, bump]);
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshApi {
  return useContext(RefreshContext);
}

/** A number that changes whenever any of `views` was invalidated. */
export function useRefreshTick(views: readonly ViewName[]): number {
  const { ticks } = useContext(RefreshContext);
  let n = 0;
  for (const v of views) n += ticks[v] ?? 0;
  return n;
}

export function toFailure(err: unknown): ApiFailure {
  if (err instanceof ApiFailure) return err;
  return new ApiFailure(0, "client", err instanceof Error ? err.message : String(err));
}

export interface Resource<T> {
  data: T | null;
  /** The last load failed (data, if any, is the previous successful one). */
  error: ApiFailure | null;
  loading: boolean;
  reload(): void;
  /** Replace the data with a mutation's answer (wins over loads still in flight). */
  set(data: T): void;
}

/**
 * Loads on mount, when `key` changes, and when one of `views` is invalidated. A background reload keeps showing the
 * previous data (no flash of a loading state); out-of-order answers are dropped.
 */
export function useResource<T>(key: string, load: () => Promise<T>, views: readonly ViewName[]): Resource<T> {
  const tick = useRefreshTick(views);
  const [manual, setManual] = useState(0);
  const [state, setState] = useState<{ key: string; data: T | null; error: ApiFailure | null; loading: boolean }>({ key, data: null, error: null, loading: true });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const my = ++seq.current;
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: null, error: null, loading: true }));
    loadRef.current().then(
      (data) => {
        if (seq.current === my) setState({ key, data, error: null, loading: false });
      },
      (err: unknown) => {
        if (seq.current === my) setState((s) => ({ key, data: s.key === key ? s.data : null, error: toFailure(err), loading: false }));
      },
    );
  }, [key, tick, manual]);

  const set = useCallback(
    (data: T) => {
      seq.current++;
      setState({ key, data, error: null, loading: false });
    },
    [key],
  );
  const reload = useCallback(() => setManual((n) => n + 1), []);
  const same = state.key === key;
  return { data: same ? state.data : null, error: same ? state.error : null, loading: same ? state.loading : true, reload, set };
}

// ==================== server clock ====================
// Every relative label ("12 分钟前") is computed against the server's clock, estimated from `generatedAt`.

let serverOffset = 0;

export function syncServerClock(generatedAt: number | undefined): void {
  if (typeof generatedAt === "number" && Number.isFinite(generatedAt)) serverOffset = generatedAt - Date.now();
}

export function serverNow(): number {
  return Date.now() + serverOffset;
}

/** Re-renders every `everyMs` so relative times stay true while a card sits on screen. */
export function useNow(everyMs = 30_000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return serverNow();
}

// ==================== toasts ====================

export type Tone = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
  title?: string;
  action?: { label: string; run(): void };
}

interface ToastApi {
  toasts: Toast[];
  push(t: Omit<Toast, "id">): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi>({ toasts: [], push: () => undefined, dismiss: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = next.current++;
      setToasts((l) => [...l.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === "error" || t.tone === "warn" ? 8_000 : 4_000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastApi["push"] {
  return useContext(ToastContext).push;
}

export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

// ==================== draft change notices (SSE `artifact`) ====================

export interface ArtifactEvent {
  artifactId: string;
  version: number;
  updatedBy: "agent" | "human";
  parked: boolean;
}

type ArtifactListener = (e: ArtifactEvent) => void;
const artifactListeners = new Set<ArtifactListener>();

export function emitArtifactEvent(e: ArtifactEvent): void {
  for (const l of [...artifactListeners]) l(e);
}

/** Calls `onChange` when the server reports a change to this draft (a new version or a parked addition). */
export function useArtifactEvents(artifactId: string | null | undefined, onChange: (e: ArtifactEvent) => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!artifactId) return;
    const l: ArtifactListener = (e) => {
      if (e.artifactId === artifactId) ref.current(e);
    };
    artifactListeners.add(l);
    return () => {
      artifactListeners.delete(l);
    };
  }, [artifactId]);
}

// ==================== keyboard ====================

export type KeyHandler = (e: KeyboardEvent) => boolean;

const viewKeyHandlers: KeyHandler[] = [];

/** The visible view's shortcuts; return true when the key was used. The most recently mounted handler goes first. */
export function useViewKeys(handler: KeyHandler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h: KeyHandler = (e) => ref.current(e);
    viewKeyHandlers.unshift(h);
    return () => {
      const i = viewKeyHandlers.indexOf(h);
      if (i >= 0) viewKeyHandlers.splice(i, 1);
    };
  }, []);
}

export function dispatchViewKey(e: KeyboardEvent): boolean {
  for (const h of [...viewKeyHandlers]) if (h(e)) return true;
  return false;
}

/** Typing somewhere: shortcuts must not fire. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

/** Elements where Enter/Space already mean "activate this" natively. */
export function isActivatableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return Boolean(t.closest("button, a[href], summary, [role=button], [role=tab], [role=menuitem], input, select, textarea, dialog"));
}

// ==================== routing ====================

export type ViewKey = "clarify" | "engage" | "radar";

export interface Route {
  view: ViewKey;
  /** Clarify: the card to show first. */
  cardId?: string;
  /** Engage: the open 8/4 workspace. */
  item?: { cellId: string; actionId: string };
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [view, a, b] = parts;
  if (view === "engage") return a && b ? { view: "engage", item: { cellId: a, actionId: b } } : { view: "engage" };
  if (view === "radar") return { view: "radar" };
  return a ? { view: "clarify", cardId: a } : { view: "clarify" };
}

export function routeHash(r: Route): string {
  const e = encodeURIComponent;
  if (r.view === "engage" && r.item) return `#/engage/${e(r.item.cellId)}/${e(r.item.actionId)}`;
  if (r.view === "clarify" && r.cardId) return `#/clarify/${e(r.cardId)}`;
  return `#/${r.view}`;
}

const NavContext = createContext<(r: Route) => void>(() => undefined);

export const NavProvider = NavContext.Provider;

export function useNavigate(): (r: Route) => void {
  return useContext(NavContext);
}
