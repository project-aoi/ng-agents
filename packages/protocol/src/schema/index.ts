import { cellSchema } from "./cell";
import { channelSchema } from "./channel";
import { contextSchema } from "./context";
import { gateSchema } from "./gate";
import { inboxSchema } from "./inbox";
import type { SchemaModule } from "./types";
import { workspaceSchema } from "./workspace";

export type { SchemaModule } from "./types";
export { cellSchema, channelSchema, contextSchema, gateSchema, inboxSchema, workspaceSchema };

/** Application order: `cells` first, since every cell-scoped table references it. */
export const ALL_SCHEMAS: readonly SchemaModule[] = [
  cellSchema,
  inboxSchema,
  contextSchema,
  gateSchema,
  workspaceSchema,
  channelSchema,
];

/** Table → owning package (for docs, tests and the ownership rule). */
export const TABLE_OWNERS: Readonly<Record<string, string>> = {
  cells: "@ng/cell",
  cell_watches: "@ng/cell",
  cell_waits: "@ng/cell",
  inbox_messages: "@ng/inbox",
  inbox_claims: "@ng/inbox",
  inbox_schedules: "@ng/inbox",
  cell_state: "@ng/context",
  artifacts: "@ng/context",
  artifact_versions: "@ng/context",
  artifact_parked: "@ng/context",
  evidence: "@ng/context",
  evidence_fts: "@ng/context",
  resources: "@ng/context",
  artifact_fts: "@ng/context",
  state_fts: "@ng/context",
  resource_fts: "@ng/context",
  knowledge: "@ng/context",
  knowledge_fts: "@ng/context",
  prompt_prefixes: "@ng/context",
  approvals: "@ng/gate",
  ledger: "@ng/gate",
  usage_log: "@ng/gate",
  budget_raises: "@ng/gate",
  action_tokens: "@ng/gate",
  policy_rules: "@ng/gate",
  approval_stats: "@ng/gate",
  workspaces: "@ng/workspace",
  jobs: "@ng/workspace",
  outbox: "@ng/channel",
  channel_state: "@ng/channel",
};
