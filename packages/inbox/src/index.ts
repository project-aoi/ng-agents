// @ng/inbox — primitive ②: durable per-cell queue, delayed and cron wake-ups, serial claims with
// leases, handback to the desk, and the control bypass (cancel / pause / resume / steer).
export { createInbox } from "./inbox";
export type {
  ControlEvent,
  ControlListener,
  InboxClaimRecord,
  InboxClaimStatus,
  InboxOptions,
  InboxReleaseOptions,
  InboxService,
  ReleaseResult,
} from "./types";
