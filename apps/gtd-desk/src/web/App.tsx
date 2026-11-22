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
  isActivatableTarget,
  isTypingTarget,
  parseRoute,
  routeHash,
  syncServerClock,
  useRefresh,
  useResource,
  useToast,
  type Route,
  type ViewKey,
} from "./state";
import { AgentsView } from "./views/Agents";
import { HumanInbox } from "./views/HumanInbox";
import { RadarView } from "./views/Radar";

const ALL_VIEWS: ViewName[] = ["inbox", "radar", "agents", "review", "status", "sources", "activity"];

export function App() {
  return (
    <ToastProvider>
      <RefreshProvider>
        <Shell />
      </RefreshProvider>
    </ToastProvider>
  );
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



  const connected = useDeskEvents({
    hello(s, reconnected) {
      setStatus(s);
      // Events may have been missed while the stream was down.
      if (reconnected) bump(ALL_VIEWS);
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
  });

  useEffect(() => {
    const n = status?.humanPending ?? 0;
    document.title = n > 0 ? `(${n}) GTD 工作台` : "GTD 工作台";
  }, [status?.humanPending]);

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
          goView("inbox");
          break;
        case "2":
          goView("radar");
          break;
        case "3":
          goView("agents");
          break;
        case "4":
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
  const view = route.view;
  const overlay = drawer.open || report !== null;

  return (
    <StatusProvider value={statusApi}>
      <NavProvider value={navigate}>
        <ReportProvider value={openReport}>
          <div className="app">
            <div className="chrome-top" inert={overlay}>
              <TopBar view={view} status={status} onView={goView} drawerOpen={drawer.open} onDrawer={() => setDrawer((d) => ({ open: !d.open, tab: d.tab }))} />
              <StatusLine view={view} status={status} connected={connected} open={panelOpen} onToggle={() => setPanelOpen((o) => !o)} onClose={closePanel} />
            </div>
            <main className={`stage${route.view === "agents" ? " stage-fill" : ""}`} ref={mainRef} inert={overlay} tabIndex={-1}>
              {route.view === "inbox" && <HumanInbox cardId={route.cardId}/>}
              {route.view === "radar" && <RadarView />}
              {route.view === "agents" && <AgentsView cellId={route.cellId} projectId={route.projectId} />}
            </main>
            <div inert={overlay}>
              <BottomBar view={view} inputRef={quickRef} />
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
