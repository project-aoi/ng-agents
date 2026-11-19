import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The owner's switch for budget limits ("token quota"). On (the default): the Gate's ledgers stop cells at their
 * limits. Off: nothing is stopped, held, warned about or refused for budget — usage is still counted, so the owner
 * keeps seeing what was spent. The choice is the owner's alone (no agent and no cell can flip it) and is kept in
 * `<dataDir>/settings.json`, so it survives restarts.
 */
export interface BudgetSwitch {
  enforced(): boolean;
  /** Returns whether the value changed. */
  set(enforced: boolean): boolean;
}

const FILE = "settings.json";

function readSettings(dataDir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `initial`: what the process was started with (a kernel option, an environment variable). When given it wins over the
 * stored choice for this process and is stored; when absent the stored choice applies, else limits are on.
 */
export function createBudgetSwitch(opts: { dataDir: string; initial?: boolean }): BudgetSwitch {
  const stored = readSettings(opts.dataDir)["budgetLimits"];
  let on = opts.initial ?? (typeof stored === "boolean" ? stored : true);

  function persist(): void {
    const all = readSettings(opts.dataDir);
    all["budgetLimits"] = on;
    if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true });
    const tmp = join(opts.dataDir, `${FILE}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, join(opts.dataDir, FILE));
  }
  if (opts.initial !== undefined && stored !== on) persist();

  return {
    enforced: () => on,
    set(next) {
      if (next === on) return false;
      on = next;
      persist();
      return true;
    },
  };
}
