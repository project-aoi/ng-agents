/**
 * One owning package's slice of the shared database.
 *
 * Rules (IMPL_BRIEF §2.2): only the owner writes its tables; only the owner edits its schema file.
 * - `ddl` describes the *current* shape and must be idempotent (`IF NOT EXISTS` everywhere). It runs on every open.
 * - To change an existing table: update `ddl`, bump `version`, and add a migration `{ version, up }` that brings an
 *   older database to that version (e.g. `ALTER TABLE ... ADD COLUMN ...`). Migrations run before `ddl`, only for
 *   databases whose stored version is lower; a fresh database just runs `ddl`.
 */
export interface SchemaModule {
  owner: string;
  version: number;
  ddl: string;
  migrations?: ReadonlyArray<{ version: number; up: string }>;
}
