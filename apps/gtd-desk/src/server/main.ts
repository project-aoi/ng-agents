// `pnpm --filter @ng/gtd-desk start` / `dev`: boot the desk from the environment and serve until a signal.

import { createDeskServer } from "./boot";
import { BackendConfigError } from "./backend";
import { SecurityConfigError } from "./security";

if (process.env["NG_DESK_TZ"]) process.env["TZ"] = process.env["NG_DESK_TZ"];

async function main(): Promise<void> {
  const server = await createDeskServer();
  const { url } = await server.listen();
  console.log(`[desk] GTD 工作台 ${url} · ${server.settings.backend}${server.security.token ? " · bearer token required" : ""}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[desk] ${signal}: shutting down`);
    const force = setTimeout(() => {
      console.error("[desk] shutdown timed out; exiting");
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("[desk] shutdown failed:", err);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err instanceof SecurityConfigError || err instanceof BackendConfigError ? `[desk] ${err.message}` : err);
  process.exit(1);
});
