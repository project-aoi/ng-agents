import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { expect, it } from "vitest";

const chrome = [
  process.env["CHROME_BIN"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));

it.skipIf(!chrome)(
  "saves a focused draft once and requires review of background changes before resubmitting a linked action after HTTP 409",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ng-inbox-browser-"));
    try {
      const entry = fileURLToPath(new URL("./fixtures/human-inbox-browser.tsx", import.meta.url));
      await build({
        configFile: false,
        logLevel: "silent",
        oxc: { jsx: { development: false } },
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: { outDir: dir, emptyOutDir: false, lib: { entry, name: "inboxTest", formats: ["iife"], fileName: () => "app.js" } },
      });
      const html = join(dir, "index.html");
      writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result"></pre><script src="./app.js"></script>');
      const { stdout } = await promisify(execFile)(
        chrome!,
        [
          "--headless",
          "--disable-gpu",
          "--disable-extensions",
          "--no-first-run",
          "--no-default-browser-check",
          "--user-data-dir=" + join(dir, "profile"),
          "--virtual-time-budget=10000",
          "--dump-dom",
          pathToFileURL(html).href,
        ],
        { timeout: 20000 },
      );
      expect(stdout).toContain('<pre id="result">{"saves":[1],"submissions":[[1,3],[2,3],[2,3],[2,3]]}</pre>');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  },
  30000,
);
