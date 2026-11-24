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

/** Where an excerpt sits in its text: UTF-16 indices `[start, end)`, never splitting a surrogate pair. */
export interface ExcerptSpan {
  start: number;
  end: number;
}

export interface ExcerptOptions {
  /** The query as typed. With more than one word, its first whole occurrence wins (see excerptSpan). */
  phrase?: string;
  /**
   * Index in `text` where the document the offset counts in begins (default 0): a knowledge hit's text is
   * `description\nbody` but its URI reads the body. `false` reports no offset (the text is not what the hit's URI reads).
   */
  origin?: number | false;
}

/** Occurrences of one word that anchor a candidate window: bounded on texts of hundreds of KB. */
const MAX_ANCHORS_PER_TERM = 2_000;
/** Distinct words ranked per text; a longer query is ranked on its first words (the phrase still uses all of them). */
const MAX_RANKED_TERMS = 32;

const escapeRegExp = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** Case-insensitive occurrences of a literal; `u`: never inside a surrogate pair, case folding follows Unicode. */
const literal = (word: string) => new RegExp(escapeRegExp(word), "giu");

/**
 * The latest occurrence of `word` starting at or before `pos`, for positions that only move forward: the whole text is
 * scanned once however often it is asked (`at` is -Infinity before the first occurrence).
 */
function latestAtOrBefore(text: string, word: string): (pos: number) => { at: number; end: number } {
  const re = literal(word);
  let next = re.exec(text);
  const latest = { at: -Infinity, end: -Infinity };
  return (pos) => {
    while (next && next.index <= pos) {
      latest.at = next.index;
      latest.end = next.index + next[0].length;
      next = re.exec(text);
    }
    return latest;
  };
}

/** `width` units of `text` with `[a, b)` in the middle, moved inward at the ends of the text, then made surrogate-safe. */
function place(text: string, a: number, b: number, width: number): ExcerptSpan {
  const n = text.length;
  let start = Math.max(0, Math.min(a - Math.floor(Math.max(0, width - (b - a)) / 2), n - width));
  let end = Math.min(n, start + width);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
  if (end < n && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { start, end };
}

/**
 * Where the excerpt of `text` for a query goes, all matching case-insensitive; null when no term occurs.
 * 1. `phrase` with more than one word: its first occurrence, words separated by any whitespace.
 * 2. The window of the excerpt's size holding the most distinct `terms`; ties go to the window holding the term that is
 *    rarest in this text, then to the earliest. The window is centred on the occurrences it holds.
 * Linear in the text: two regex scans per term. Windows are anchored on each term's first MAX_ANCHORS_PER_TERM
 * occurrences (a rarer term's occurrences are all anchors), but whether a window holds a term is checked exactly.
 */
export function excerptSpan(text: string, terms: readonly string[], radius = 80, phrase?: string): ExcerptSpan | null {
  const r = Math.max(0, Math.floor(radius));
  const phraseWords = phrase?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (phraseWords.length > 1) {
    const m = new RegExp(phraseWords.map(escapeRegExp).join("\\s+"), "iu").exec(text);
    if (m) return place(text, m.index, m.index + m[0].length, 2 * r + m[0].length);
  }

  const words: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    words.push(t);
    if (words.length === MAX_RANKED_TERMS) break;
  }
  // Anchors, and per word how often it occurs (counted up to the cap: a capped word is as common as can be).
  const anchors: Array<{ at: number; w: number }> = [];
  const totals: number[] = [];
  let maxLen = 0;
  words.forEach((word, w) => {
    const re = literal(word);
    let n = 0;
    for (let m = re.exec(text); m && n < MAX_ANCHORS_PER_TERM; m = re.exec(text)) {
      anchors.push({ at: m.index, w });
      maxLen = Math.max(maxLen, m[0].length);
      n++;
    }
    totals[w] = n;
  });
  if (anchors.length === 0) return null;
  anchors.sort((x, y) => x.at - y.at || x.w - y.w);

  // The window ending at an anchor holds the words with an occurrence starting at most 2r before it; their latest such
  // occurrences give the tightest span (at most 2r + maxLen wide), which the excerpt is centred on.
  const latest = words.map((word) => latestAtOrBefore(text, word));
  let best = { distinct: 0, rarest: Infinity, a: 0, b: 0 };
  for (const o of anchors) {
    let distinct = 0;
    let rarest = Infinity;
    let a = o.at;
    let b = o.at;
    latest.forEach((latestOf, w) => {
      const l = latestOf(o.at);
      if (l.at < o.at - 2 * r) return;
      distinct++;
      rarest = Math.min(rarest, totals[w]!);
      a = Math.min(a, l.at);
      b = Math.max(b, l.end);
    });
    const better =
      distinct > best.distinct ||
      (distinct === best.distinct && (rarest < best.rarest || (rarest === best.rarest && a < best.a)));
    if (better) best = { distinct, rarest, a, b };
  }
  return place(text, best.a, best.b, 2 * r + maxLen);
}

/** The excerpt text for a span of `text`; see excerpt for the format. */
export function formatExcerpt(text: string, span: ExcerptSpan, origin: number | false = 0): string {
  const { start, end } = span;
  const body = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
  const offset = origin === false ? 0 : start - origin;
  return offset > 0 ? `@${offset} ${body}` : body;
}

/**
 * An excerpt of `text` for a search query (placed by excerptSpan), whitespace collapsed, with "…" where text is cut.
 * When it does not start at the beginning of the document, it is prefixed with `@<offset> `: the UTF-16 character
 * offset in the document (read_resource's `offset`) where the excerpt starts, e.g. `@48213 …step 5997 ok step 5998
 * failed…`. No term in the text: its beginning, on one line (no offset).
 */
export function excerpt(text: string, terms: readonly string[], radius = 80, opts: ExcerptOptions = {}): string {
  const span = excerptSpan(text, terms, radius, opts.phrase);
  return span ? formatExcerpt(text, span, opts.origin ?? 0) : oneLine(text, radius * 2);
}
