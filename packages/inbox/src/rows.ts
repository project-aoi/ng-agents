import {
  fromJson,
  toBool,
  type Envelope,
  type InboxMessageRecord,
  type InboxMessageStatus,
  type InboxScheduleRecord,
} from "@ng/protocol";
import type { InboxClaimRecord, InboxClaimStatus } from "./types";

export interface MessageRow {
  seq: number;
  cell_id: string;
  envelope_id: string;
  envelope: string;
  kind: string;
  type: string;
  delivery: string;
  principal_id: string;
  status: string;
  status_reason: string | null;
  deliver_at: number;
  cancel_group: string | null;
  schedule_id: string | null;
  expected_epoch: number | null;
  claim_id: string | null;
  first_claimed_at: number | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface ScheduleRow {
  id: string;
  cell_id: string;
  template_id: string;
  envelope: string;
  cron: string;
  tz: string | null;
  cancel_group: string | null;
  expected_epoch: number | null;
  next_fire_at: number | null;
  last_fired_at: number | null;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface ClaimRow {
  claim_id: string;
  cell_id: string;
  worker_id: string;
  epoch: number;
  status: string;
  claimed_at: number;
  lease_expires_at: number;
  finished_at: number | null;
  release_reason: string | null;
}

export function toMessage(r: MessageRow): InboxMessageRecord {
  return {
    seq: r.seq,
    cellId: r.cell_id,
    envelope: fromJson<Envelope>(r.envelope),
    status: r.status as InboxMessageStatus,
    deliverAt: r.deliver_at,
    cancelGroup: r.cancel_group,
    scheduleId: r.schedule_id,
    expectedEpoch: r.expected_epoch,
    claimId: r.claim_id,
    firstClaimedAt: r.first_claimed_at,
    attempts: r.attempts,
    statusReason: r.status_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toSchedule(r: ScheduleRow): InboxScheduleRecord {
  return {
    id: r.id,
    cellId: r.cell_id,
    template: fromJson<Envelope>(r.envelope),
    cron: r.cron,
    tz: r.tz,
    cancelGroup: r.cancel_group,
    expectedEpoch: r.expected_epoch,
    nextFireAt: r.next_fire_at,
    lastFiredAt: r.last_fired_at,
    active: toBool(r.active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toClaim(r: ClaimRow): InboxClaimRecord {
  return {
    claimId: r.claim_id,
    cellId: r.cell_id,
    workerId: r.worker_id,
    epoch: r.epoch,
    status: r.status as InboxClaimStatus,
    claimedAt: r.claimed_at,
    leaseExpiresAt: r.lease_expires_at,
    finishedAt: r.finished_at,
    releaseReason: r.release_reason,
  };
}
