/**
 * Where secret values live. Only `Gate.injectSecretSync` (host side) ever calls `get`; `authorize` only asks `has`.
 * Values never enter a sandbox, a Loop, an approval row, a bus event or an error message.
 */
export interface SecretStore {
  has(ref: string): boolean;
  get(ref: string): string | undefined;
  /** Optional enumeration, used only to scrub known values out of anything Gate persists. */
  refs?(): string[];
}

export const SECRET_ENV_PREFIX = "NG_SECRET_";

/** `github` → `NG_SECRET_GITHUB`, `feishu.app-secret` → `NG_SECRET_FEISHU_APP_SECRET`. */
export function secretEnvName(ref: string, prefix: string = SECRET_ENV_PREFIX): string {
  return prefix + ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export interface EnvSecretStoreOptions {
  env?: Record<string, string | undefined>;
  prefix?: string;
}

/** Default store: reads `NG_SECRET_<REF>` from the environment at call time. Empty values count as not configured. */
export function envSecretStore(opts: EnvSecretStoreOptions = {}): SecretStore {
  const env = opts.env ?? process.env;
  const prefix = opts.prefix ?? SECRET_ENV_PREFIX;
  const read = (ref: string) => {
    if (!ref) return undefined;
    const v = env[secretEnvName(ref, prefix)];
    return v ? v : undefined;
  };
  return {
    has: (ref) => read(ref) !== undefined,
    get: read,
    // Env names are lossy (case, separators), so enumeration yields env-style refs; `get` maps them back identically.
    refs: () => Object.keys(env).filter((k) => k.startsWith(prefix) && env[k]).map((k) => k.slice(prefix.length)),
  };
}

/** In-memory store (tests, or an app that loads secrets from its own vault). */
export function memorySecretStore(values: Record<string, string>): SecretStore {
  const map = new Map(Object.entries(values).filter(([, v]) => v));
  return {
    has: (ref) => map.has(ref),
    get: (ref) => map.get(ref),
    refs: () => [...map.keys()],
  };
}

// Shorter values would turn ordinary words into "[redacted]"; a real credential is never this short.
const MIN_REDACT_LENGTH = 6;

/** Replaces every occurrence of a known secret value in strings anywhere inside `value` (returns a copy). */
export function redactSecrets<T>(value: T, secrets: ReadonlyMap<string, string>): T {
  const pairs = [...secrets].filter(([v]) => v.length >= MIN_REDACT_LENGTH).sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return value;
  const scrub = (s: string) => {
    let out = s;
    for (const [secret, ref] of pairs) if (out.includes(secret)) out = out.split(secret).join(`[redacted:${ref}]`);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
