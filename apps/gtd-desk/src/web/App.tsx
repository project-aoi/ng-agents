import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactRefDTO, StatusDTO, ViewName } from "../shared/api";
import { api } from "./api";
import { COMPOSER_INPUT_ID } from "./components/agents/composer";
import { BottomBar, StatusLine, Toasts, TopBar } from "./components/chrome";
import { Drawer, type DrawerTab } from "./components/drawer";
import { ReportDrawer } from "./components/report";
import { useDeskEvents } from "./live";
import {
  NavProvider,
  RefreshProvider,
  ReportProvider,
  StatusProvider,
  ToastProvider,
  dispatchViewKey,
  emitArtifactEvent,
  emitCellTail,
  emitJobChunk,
  isActivatableTarget,
  isTypingTarget,
  parseRoute,
  routeHash,
  syncServerClock,
  toFailure,
  useRefresh,
  useResource,
  useToast,
  type Route,
  type ViewKey,
} from "./state";
import { AgentsView } from "./views/Agents";
import { ClarifyView } from "./views/Clarify";
import { EngageView } from "./views/Engage";
import { RadarView } from "./views/Radar";

const ALL_VIEWS: ViewName[] = ["clarify", "engage", "radar", "agents", "review", "status", "sources", "activity"];

export function App() {
  return (
    <ToastProvider>
      <RefreshProvider>
        <Shell />
      </RefreshProvider>
    </ToastProvider>
  );
}

/**
 * Being in 🎯 Engage is what turns focus (DND) on; any other view — 分身实况 included — turns it off (docs/04 §一,
 * §三). Requests are serialized and coalesced to the latest wish, so quick tab switching cannot leave the server in
 * the wrong state.
 */
function useFocusMode(on: boolean, onStatus: (s: StatusDTO) => void) {
  const toast = useToast();
  const desired = useRef(on);
  const confirmed = useRef<boolean | null>(null);
  const running = useRef(false);
  const deps = useRef({ toast, onStatus });
  deps.current = { toast, onStatus };
  desired.current = on;

  const sync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (confirmed.current !== desired.current) {
        const want = desired.current;
        try {
          const r = await api.focus(want);
          confirmed.current = r.focus.on;
          deps.current.onStatus(r.status);
          const delivered = r.flushed ? r.flushed.sent + r.flushed.failed + r.flushed.unknown : 0;
          if (!want && delivered > 0) deps.current.toast({ tone: "info", text: r.message });
          if (r.focus.on !== want) break;
        } catch (err) {
          const f = toFailure(err);
          // Without the access token every view already shows the token form; one more notice would be noise.
          if (!f.unauthorized) deps.current.toast({ tone: "error", text: `免打扰没能${want ? "开启" : "关闭"}：${f.message}` });
          break;
        }
      }
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    void sync();
  }, [on, sync]);

  useEffect(() => {
    // Closing the tab while focused must not leave notifications held forever.
    const onHide = () => {
      if (confirmed.current) {
        void api.focus(false, true).catch(() => undefined);
        confirmed.current = null;
      }
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        confirmed.current = null;
        void sync();
      }
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, [sync]);

  /** After the server came back (it may have restarted, or a request failed meanwhile): state the wish again. */
  return useCallback(() => {
    confirmed.current = null;
    void sync();
  }, [sync]);
}

function Shell() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({ open: false, tab: "capture" });
  const [panelOpen, setPanelOpen] = useState(false);
  const [report, setReport] = useState<ArtifactRefDTO | null>(null);
  const statusRes = useResource<StatusDTO>("status", api.status, ["status"]);
  const { bump } = useRefresh();
  const toast = useToast();
  const quickRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const setStatus = statusRes.set;
  const status = statusRes.data;
  useEffect(() => {
    if (status) syncServerClock(status.generatedAt);
  }, [status]);

  useEffect(() => {
    if (!window.location.hash) history.replaceState(null, "", routeHash(parseRoute("")));
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((r: Route) => {
    const hash = routeHash(r);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(r);
    setPanelOpen(false);
    setDrawer((d) => (d.open ? { ...d, open: false } : d));
    setReport(null);
    mainRef.current?.scrollTo({ top: 0 });
  }, []);
  const goView = useCallback((v: ViewKey) => navigate({ view: v }), [navigate]);

  const resyncFocus = useFocusMode(route.view === "engage", setStatus);

  const connected = useDeskEvents({
    hello(s, reconnected) {
      setStatus(s);
      // Events may have been missed while the stream was down.
      if (reconnected) {
        bump(ALL_VIEWS);
        resyncFocus();
      }
    },
    refresh(views) {
      bump(views);
    },
    artifact(e) {
      emitArtifactEvent(e);
    },
    notification(n) {
      toast({ tone: "info", ...(n.title ? { title: n.title } : {}), text: n.text });
    },
    cellTail(e) {
      emitCellTail(e);
    },
    jobChunk(e) {
      emitJobChunk(e);
    },
  });

  useEffect(() => {
    const n = status?.clarify.pending ?? 0;
    document.title = n > 0 ? `(${n}) GTD 工作台` : "GTD 工作台";
  }, [status?.clarify.pending]);

  const closePanel = useCallback(() => setPanelOpen(false), []);
  const openReport = useCallback((r: ArtifactRefDTO) => {
    setDrawer((d) => (d.open ? { ...d, open: false } : d));
    setReport(r);
  }, []);
  const viewRef = useRef(route.view);
  viewRef.current = route.view;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") {
        if (report) {
          setReport(null);
        } else if (drawer.open) {
          setDrawer((d) => ({ ...d, open: false }));
        } else if (panelOpen) {
          setPanelOpen(false);
        } else if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
        } else {
          dispatchViewKey(e);
          return;
        }
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (!drawer.open && dispatchViewKey(e)) e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case "1":
          goView("clarify");
          break;
        case "2":
          goView("engage");
          break;
        case "3":
          goView("radar");
          break;
        case "4":
          goView("agents");
          break;
        case "5":
          setReport(null);
          setDrawer((d) => ({ open: !d.open, tab: d.open ? d.tab : "sources" }));
          break;
        case "/": {
          setDrawer((d) => ({ ...d, open: false }));
          setReport(null);
          // In 分身实况 the bottom bar is folded away: "/" goes to the selected node's own box instead.
          const box = viewRef.current === "agents" ? document.getElementById(COMPOSER_INPUT_ID) : null;
          if (box) box.focus();
          else if (viewRef.current === "agents") setDrawer({ open: true, tab: "capture" });
          else quickRef.current?.focus();
          break;
        }
        default:
          if (drawer.open || panelOpen || report) return;
          if (e.key === "Enter" && isActivatableTarget(e.target)) return;
          if (!dispatchViewKey(e)) return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer.open, panelOpen, report, goView]);

  const statusApi = useMemo(() => ({ status, setStatus }), [status, setStatus]);
  const overlay = drawer.open || report !== null;

  return (
    <StatusProvider value={statusApi}>
      <NavProvider value={navigate}>
        <ReportProvider value={openReport}>
          <div className="app">
            <div className="chrome-top" inert={overlay}>
              <TopBar view={route.view} status={status} onView={goView} drawerOpen={drawer.open} onDrawer={() => setDrawer((d) => ({ open: !d.open, tab: d.tab }))} />
              <StatusLine view={route.view} status={status} connected={connected} open={panelOpen} onToggle={() => setPanelOpen((o) => !o)} onClose={closePanel} />
            </div>
            <main className={`stage${route.view === "agents" ? " stage-fill" : ""}`} ref={mainRef} inert={overlay} tabIndex={-1}>
              {route.view === "clarify" && <ClarifyView cardId={route.cardId} />}
              {route.view === "engage" && <EngageView item={route.item} />}
              {route.view === "radar" && <RadarView />}
              {route.view === "agents" && <AgentsView cellId={route.cellId} projectId={route.projectId} />}
            </main>
            <div inert={overlay}>
              <BottomBar view={route.view} inputRef={quickRef} workspace={route.view === "engage" && route.item !== undefined} />
            </div>
            <Drawer open={drawer.open} tab={drawer.tab} onTab={(tab) => setDrawer({ open: true, tab })} onClose={() => setDrawer((d) => ({ ...d, open: false }))} />
            <ReportDrawer report={report} onClose={() => setReport(null)} />
            <Toasts />
          </div>
        </ReportProvider>
      </NavProvider>
    </StatusProvider>
  );
}
