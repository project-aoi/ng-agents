/** Each owner defines the tables it needs when the database opens. DDL must be idempotent. */
export interface SchemaModule {
  owner: string;
  version: 1;
  ddl: string;
  migrations: readonly [];
}
