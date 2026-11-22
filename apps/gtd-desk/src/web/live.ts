import { useEffect, useRef, useState } from "react";
import type { NotificationDTO, StatusDTO, ViewName } from "../shared/api";
import { eventsUrl } from "./api";
import type { ArtifactEvent, CellTailEvent } from "./state";

export interface DeskEventHandlers {
  hello(status: StatusDTO, reconnected: boolean): void;
  refresh(views: ViewName[]): void;
  artifact(e: ArtifactEvent): void;
  notification(n: NotificationDTO): void;
  /** New records on one cell's timeline (the open Agents pane fetches what it lacks). */
  cellTail(e: CellTailEvent): void;
  /** Live output of a cell's background command. */
}

const MIN_DELAY = 1_000;
const MAX_DELAY = 30_000;

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribes to /api/events. EventSource gives up for good on an HTTP error (e.g. 401) and retries a dropped stream on
 * its own fixed schedule, so the stream is always closed on error and reopened here with jittered exponential backoff.
 * Returns whether the stream is currently open.
 */
export function useDeskEvents(handlers: DeskEventHandlers): boolean {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everConnected = false;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const source = new EventSource(eventsUrl());
      es = source;
      timer = null;
      es.addEventListener("hello", (e) => {
        if (stopped || es !== source) return;
        const d = parse<{ status: StatusDTO }>(e);
        attempt = 0;
        setConnected(true);
        if (d) ref.current.hello(d.status, everConnected);
        everConnected = true;
      });
      es.addEventListener("refresh", (e) => {
        if (stopped || es !== source) return;
        const d = parse<{ views: ViewName[] }>(e);
        if (d && Array.isArray(d.views)) ref.current.refresh(d.views);
      });
      es.addEventListener("artifact", (e) => {
        if (stopped || es !== source) return;
        const d = parse<ArtifactEvent>(e);
        if (d) ref.current.artifact(d);
      });
      es.addEventListener("notification", (e) => {
        if (stopped || es !== source) return;
        const d = parse<NotificationDTO>(e);
        if (d) ref.current.notification(d);
      });
      es.addEventListener("cell_tail", (e) => {
        if (stopped || es !== source) return;
        const d = parse<CellTailEvent>(e);
        if (d && typeof d.cellId === "string" && typeof d.lastSeq === "number") ref.current.cellTail(d);
      });
      es.onerror = () => {
        if (stopped || es !== source) return;
        if (timer) clearTimeout(timer);
        everConnected = true;
        es?.close();
        es = null;
        setConnected(false);
        const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** attempt);
        attempt++;
        timer = setTimeout(connect, base * (0.75 + Math.random() * 0.5));
      };
    };

    connect();
    // A tab coming back from sleep should not wait out a long backoff.
    const onVisible = () => {
      if (document.visibilityState === "visible" && !es && timer) {
        clearTimeout(timer);
        timer = null;
        attempt = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, []);

  return connected;
}
