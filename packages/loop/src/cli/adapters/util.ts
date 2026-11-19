/** describePermissions wording for a writing cell on the host: nothing in the CLI or the OS confines it (docs/05). */
export const HOST_UNSANDBOXED = "unsandboxed host access; guarded by the cell's prompt contract (the red lines and the look-before-you-change rule)";

export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Tool output as text: a string, or MCP/Anthropic-style content blocks (text kept, other blocks named). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = asRecord(c);
        if (typeof b["text"] === "string") return b["text"];
        const inner = asRecord(b["content"]);
        if (typeof inner["text"] === "string") return inner["text"];
        return b["type"] ? `[${String(b["type"])}]` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/** A TOML value for `codex -c key=value` (JSON strings/arrays are valid TOML basic strings/arrays). */
export function tomlValue(v: string | number | boolean | readonly string[]): string {
  return JSON.stringify(v);
}

export function tomlInlineTable(o: Record<string, string>): string {
  return `{ ${Object.entries(o)
    .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join(", ")} }`;
}
