// @ng/gtd-desk — the GTD workbench: HTTP API + projections over the kernel (src/server), the shared DTO contract
// (src/shared/api.ts) and the web client (src/web).

export { createDeskServer, DEFAULT_PORT, type DeskServer, type DeskServerOptions } from "./server/boot";
export { selectBackend, modelConfigured, billReportedCostFromEnv, BackendConfigError, type BackendChoice, type SelectBackendOptions } from "./server/backend";
export { createDemoMode, placeholderDemoModel, PLACEHOLDER_DEMO, DEMO_NOTICE, type DemoMode, type SeedContext } from "./server/demo";
export { createDesk, DeskError, type Desk } from "./server/desk";
export { createDeskApp } from "./server/app";
export * from "./server/projections";
export type * from "./shared/api";
