export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Picks an interpreter by extension so the script need not be executable. */
export function scriptCommand(path: string, env: Record<string, string>): string {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  const q = shellQuote(path);
  let runner: string;
  if (ext === "sh" || ext === "bash") runner = `bash ${q}`;
  else if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "mts") runner = `node ${q}`;
  else if (ext === "py") runner = `python3 ${q}`;
  else runner = shellQuote(path.startsWith("/") || path.startsWith("./") || path.startsWith("../") ? path : `./${path}`);
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...assignments, runner].join(" ");
}
