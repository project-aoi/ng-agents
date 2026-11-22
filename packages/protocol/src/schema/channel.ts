import type { SchemaModule } from "./types";

export const channelSchema: SchemaModule = {
  owner: "@ng/channel",
  version: 1,
  migrations: [],
  ddl: `
CREATE TABLE IF NOT EXISTS owner_notifications (
  id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL REFERENCES cells(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_notifications_time ON owner_notifications(created_at DESC);
`,
};
