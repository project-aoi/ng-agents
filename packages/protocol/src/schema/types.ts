import type { Db } from "../db/sqlite";

export interface SchemaMigration {
  from: number;
  to: number;
  run(db: Db): void;
}

/** Each owner defines the tables it needs when the database opens. DDL must be idempotent. */
export interface SchemaModule {
  owner: string;
  version: number;
  ddl: string;
  migrations: readonly SchemaMigration[];
}
