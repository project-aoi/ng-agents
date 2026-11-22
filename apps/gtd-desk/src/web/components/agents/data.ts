import { useCallback, useEffect, useRef, useState } from "react";
import type { CellJobDTO, CellTimelineDTO, TimelineItemDTO, TopologyNodeDTO } from "../../../shared/api";
import { api, type ApiFailure } from "../../api";
import { syncServerClock, toFailure, useCellLive, useDebouncedRefresh } from "../../state";
import { itemEnd, mergeItems } from "./model";

// One cell's timeline as the right pane shows it. The first page is the newest one; after that nothing is refetched
// wholesale: `cell_tail` events fetch only what came after the last record shown (appended in place, no flicker), a
// `refresh` of "agents" does the same — which also refreshes the header (state, box mode, controls, jobs) — and
// "加载更早" prepends the page before the first one.

const PAGE = 100;
/** Live output kept per background command (its tail is what matters). */

/**
 * A message typed here that the timeline does not show yet. The server records it on the timeline when the node takes
 * it in (as an item whose id is the message's clientId), which can be a while after the send was accepted: until
 * then it stays at the bottom, marked as delivered.
 */
export interface PendingMessage {
  clientId: string;
  text: string;
  mode: "enqueue" | "steer";
  at: number;
  state: "sending" | "sent";
}

interface State {
  /** Header data of the latest fetch (its `items` are not used: see `items`). */
  head: CellTimelineDTO | null;
  items: TimelineItemDTO[];
  firstSeq: number;
  hasEarlier: boolean;
  jobs: CellJobDTO[];
  pending: PendingMessage[];
  error: ApiFailure | null;
  /** The last live update failed (what is shown is still valid, just possibly behind). */
  tailError: string | null;
  loading: boolean;
  loadingEarlier: boolean;
}

const EMPTY: State = { head: null, items: [], firstSeq: 0, hasEarlier: false, jobs: [], pending: [], error: null, tailError: null, loading: true, loadingEarlier: false };

export interface CellTimeline extends Omit<State, "head"> {
  head: CellTimelineDTO | null;
  reload(): void;
  /** Fetch what came after the last record, with a fresh header. */
  refresh(): void;
  loadEarlier(): Promise<void>;
  /** A fresher tail that came with a send. */
  apply(tl: CellTimelineDTO): void;
  setNode(node: TopologyNodeDTO): void;
  addPending(p: PendingMessage): void;
  settlePending(clientId: string, outcome: "sent" | "failed"): void;
}

/**
 * Drops the pending messages that `items` now show: same id, or — for newly arrived items only (`byText`), as a
 * fallback should a server ever store them under another id — the same words said directly.
 */
function unconfirmed(pending: readonly PendingMessage[], items: readonly TimelineItemDTO[], byText: boolean): PendingMessage[] {
  if (pending.length === 0) return pending as PendingMessage[];
  const ids = new Set(items.map((i) => i.id));
  const said = new Set<string>();
  if (byText) for (const i of items) if (i.kind === "user_chat" && i.direct) said.add(i.text.trim());
  return pending.filter((p) => !ids.has(p.clientId) && !(p.state === "sent" && said.has(p.text)));
}

function lastOf(items: readonly TimelineItemDTO[]): number {
  let n = 0;
  for (const it of items) n = Math.max(n, itemEnd(it));
  return n;
}

export function useCellTimeline(cellId: string): CellTimeline {
  const [s, setS] = useState<State>(EMPTY);
  const [manual, setManual] = useState(0);
  const gen = useRef(0);
  const loaded = useRef(false);
  const lastSeq = useRef(0);
  const firstSeq = useRef(0);
  /** Highest seq announced by `cell_tail`, and the highest one a finished fetch has covered. */
  const wanted = useRef(0);
  const covered = useRef(0);
  const tailBusy = useRef<number | null>(null);
  const tailAgain = useRef(false);
  const earlierBusy = useRef(false);

  useEffect(() => {
    const my = ++gen.current;
    loaded.current = false;
    lastSeq.current = 0;
    firstSeq.current = 0;
    wanted.current = 0;
    covered.current = 0;
    setS((st) => ({ ...EMPTY, head: st.head?.node.cellId === cellId ? st.head : null }));
    api.timeline(cellId, { limit: PAGE }).then(
      (tl) => {
        if (gen.current !== my) return;
        syncServerClock(tl.generatedAt);
        loaded.current = true;
        lastSeq.current = Math.max(tl.lastSeq, lastOf(tl.items));
        if (wanted.current > lastSeq.current) void fetchTail();
        firstSeq.current = tl.items.length ? tl.firstSeq || tl.items[0]!.seq : 0;
        setS({ ...EMPTY, head: tl, items: tl.items, firstSeq: firstSeq.current, hasEarlier: tl.hasEarlier, jobs: tl.jobs, loading: false });
      },
      (err: unknown) => {
        if (gen.current === my) setS((st) => ({ ...st, error: toFailure(err), loading: false }));
      },
    );
  }, [cellId, manual]);

  const applyTail = useCallback((tl: CellTimelineDTO) => {
    syncServerClock(tl.generatedAt);
    lastSeq.current = Math.max(lastSeq.current, tl.lastSeq, lastOf(tl.items));
    if (firstSeq.current === 0 && tl.items.length) firstSeq.current = tl.firstSeq || tl.items[0]!.seq;
    setS((st) => {
      const items = mergeItems(st.items, tl.items);
      const pending = unconfirmed(st.pending, tl.items, true);
      return {
        ...st,
        head: tl,
        items,
        firstSeq: st.firstSeq || firstSeq.current,
        hasEarlier: st.items.length ? st.hasEarlier : tl.hasEarlier,
        jobs: tl.jobs,
        pending,
        tailError: null,
      };
    });
  }, []);

  const fetchTail = useCallback(async () => {
    if (!loaded.current) return; // The initial fetch checks wanted before finishing.
    const my = gen.current;
    if (tailBusy.current === my) {
      tailAgain.current = true;
      return;
    }
    tailBusy.current = my;
    try {
      do {
        tailAgain.current = false;
        const want = wanted.current;
        let tl: CellTimelineDTO;
        try {
          tl = await api.timeline(cellId, { afterSeq: lastSeq.current });
        } catch (err) {
          if (gen.current === my) setS((st) => ({ ...st, tailError: toFailure(err).message }));
          break;
        }
        if (gen.current !== my) break;
        covered.current = Math.max(covered.current, want);
        applyTail(tl);
        // A capped page: keep going while it brings something new.
        if (tl.items.length > 0 && lastSeq.current < wanted.current) tailAgain.current = true;
      } while (tailAgain.current);
    } finally {
      if (tailBusy.current === my) tailBusy.current = null;
    }
  }, [cellId, applyTail]);

  useCellLive(cellId, {
    tail(e) {
      wanted.current = Math.max(wanted.current, e.lastSeq);
      // Records the timeline leaves out (internal bookkeeping) also move lastSeq: fetch once, not on every echo.
      if (e.lastSeq <= Math.max(lastSeq.current, covered.current)) return;
      void fetchTail();
    },
  });

  useDebouncedRefresh(["agents"], 400, () => void fetchTail());

  const loadEarlier = useCallback(async () => {
    const before = firstSeq.current;
    if (earlierBusy.current || !before) return;
    earlierBusy.current = true;
    const my = gen.current;
    setS((st) => ({ ...st, loadingEarlier: true }));
    try {
      const tl = await api.timeline(cellId, { beforeSeq: before, limit: PAGE });
      if (gen.current !== my) return;
      if (tl.items.length) firstSeq.current = Math.min(before, tl.firstSeq || tl.items[0]!.seq);
      setS((st) => ({ ...st, items: mergeItems(st.items, tl.items), firstSeq: firstSeq.current, hasEarlier: tl.hasEarlier && tl.items.length > 0, loadingEarlier: false, tailError: null }));
    } catch (err) {
      if (gen.current === my) setS((st) => ({ ...st, loadingEarlier: false, tailError: `更早的记录没能载入：${toFailure(err).message}` }));
    } finally {
      earlierBusy.current = false;
    }
  }, [cellId]);

  const apply = applyTail;
  const refresh = useCallback(() => void fetchTail(), [fetchTail]);
  const reload = useCallback(() => setManual((n) => n + 1), []);
  const setNode = useCallback((node: TopologyNodeDTO) => setS((st) => (st.head ? { ...st, head: { ...st.head, node } } : st)), []);
  const addPending = useCallback((p: PendingMessage) => setS((st) => ({ ...st, pending: [...st.pending.filter((x) => x.clientId !== p.clientId), p] })), []);
  const settlePending = useCallback((clientId: string, outcome: "sent" | "failed") => {
    setS((st) => {
      if (outcome === "failed") return { ...st, pending: st.pending.filter((p) => p.clientId !== clientId) };
      // The timeline may already show it (a fast node, or a retry of a message that had gone through).
      const pending = st.pending.map((p): PendingMessage => (p.clientId === clientId ? { ...p, state: "sent" } : p));
      return { ...st, pending: unconfirmed(pending, st.items, false) };
    });
  }, []);

  return { ...s, reload, refresh, loadEarlier, apply, setNode, addPending, settlePending };
}
