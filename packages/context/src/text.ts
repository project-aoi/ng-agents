import { stableStringify } from "@ng/protocol";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** First `n` UTF-16 units, shortened by one if the cut would split a surrogate pair (providers reject lone surrogates). */
export function safeHead(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  const end = isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n;
  return text.slice(0, end);
}

/** Last `n` UTF-16 units, shortened by one if the cut would split a surrogate pair. */
export function safeTail(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  let start = text.length - n;
  if (isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/** Collapse whitespace to single spaces and cap the length (with an ellipsis). */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${safeHead(flat, Math.max(0, max - 1))}…` : flat;
}

/** Number of user-perceived code points (the FTS5 trigram tokenizer works on characters, not UTF-16 units). */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Deterministic pretty JSON: keys sorted at every level (stableStringify), then indented. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2);
}

/** Byte-for-byte comparison of plain strings, independent of locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escape LIKE wildcards; use with `ESCAPE '\'`. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Quote one term as an FTS5 string (phrase) so user input can never be parsed as query syntax. */
export function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** An excerpt of `text` around the first case-insensitive occurrence of any of `terms`. */
export function excerpt(text: string, terms: readonly string[], radius = 80): string {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at < 0) return oneLine(text, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + len + radius);
  let out = text.slice(start, end);
  if (start > 0 && isLowSurrogate(out.charCodeAt(0))) out = out.slice(1);
  if (end < text.length && isHighSurrogate(out.charCodeAt(out.length - 1))) out = out.slice(0, -1);
  return `${start > 0 ? "…" : ""}${out.replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}
