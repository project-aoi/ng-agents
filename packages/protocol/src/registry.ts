import { NgError } from "./errors";
import type { PresetDef } from "./contract/cell";
import { assertToolName, type CodeProcessor, type PromptDef, type ToolDef, type Toolset } from "./contract/loop";

/** A name → definition map. `register` throws NgError("duplicate") on a second definition with the same name. */
export interface NamedRegistry<T extends { readonly name: string }> {
  register(def: T): T;
  get(name: string): T | undefined;
  /** Throws NgError("not_found"). */
  require(name: string): T;
  has(name: string): boolean;
  list(): T[];
}

/**
 * Everything a JSON-serializable CellSpec refers to by name (specs are persisted in `cells.spec`, so they cannot hold
 * functions): toolsets (ProcessorSpec.llm.toolsets), code processors (ProcessorSpec.code.entry), presets
 * (CellSpec.preset) and prompts (ProcessorSpec.llm.prompt). Presets register into it at startup; the kernel, Context
 * and Loop read from the same instance.
 */
export interface Registry {
  reserveState(keys: readonly string[], prefixes: readonly string[]): void;
  isReservedStateKey(key: string): boolean;
  readonly toolsets: NamedRegistry<Toolset>;
  readonly codeProcessors: NamedRegistry<CodeProcessor>;
  readonly presets: NamedRegistry<PresetDef>;
  readonly prompts: NamedRegistry<PromptDef>;
  /** Flatten toolsets in order. Throws NgError("not_found") for an unknown toolset, NgError("duplicate") if two expose the same tool name. */
  resolveTools(toolsetNames: readonly string[]): ToolDef[];
}

function namedRegistry<T extends { readonly name: string }>(kind: string, validate?: (def: T) => void): NamedRegistry<T> {
  const map = new Map<string, T>();
  return {
    register(def) {
      if (!def.name) throw new NgError("invalid_argument", `${kind}: empty name`);
      if (map.has(def.name)) throw new NgError("duplicate", `${kind} "${def.name}" is already registered`);
      validate?.(def);
      map.set(def.name, def);
      return def;
    },
    get: (name) => map.get(name),
    require(name) {
      const def = map.get(name);
      if (!def) throw new NgError("not_found", `${kind} "${name}" is not registered`);
      return def;
    },
    has: (name) => map.has(name),
    list: () => [...map.values()],
  };
}

export function createRegistry(): Registry {
  const toolsets = namedRegistry<Toolset>("toolset", (ts) => {
    const seen = new Set<string>();
    for (const tool of ts.tools) {
      assertToolName(tool.name);
      if (seen.has(tool.name)) throw new NgError("duplicate", `toolset "${ts.name}" defines tool "${tool.name}" twice`);
      seen.add(tool.name);
    }
  });
  const protectedKeys = new Set<string>();
  const protectedPrefixes = new Set(["cli:", "sys:", "cell:", "pull:"]);
  return {
    reserveState(keys, prefixes) {
      for (const key of keys) protectedKeys.add(key);
      for (const prefix of prefixes) protectedPrefixes.add(prefix);
    },
    isReservedStateKey(key) {
      return protectedKeys.has(key) || [...protectedPrefixes].some(prefix => key.startsWith(prefix));
    },
    toolsets,
    codeProcessors: namedRegistry<CodeProcessor>("code processor", (p) => {
      if (p.name.startsWith("script:")) throw new NgError("invalid_argument", `code processor names cannot start with "script:"`);
    }),
    presets: namedRegistry<PresetDef>("preset"),
    prompts: namedRegistry<PromptDef>("prompt"),
    resolveTools(names) {
      const out: ToolDef[] = [];
      const owner = new Map<string, string>();
      for (const name of names) {
        for (const tool of toolsets.require(name).tools) {
          const prev = owner.get(tool.name);
          if (prev !== undefined) {
            throw new NgError("duplicate", `tool "${tool.name}" is exposed by both toolset "${prev}" and "${name}"`);
          }
          owner.set(tool.name, name);
          out.push(tool);
        }
      }
      return out;
    },
  };
}
