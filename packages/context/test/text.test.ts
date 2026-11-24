import { describe, expect, it } from "vitest";
import { excerpt, excerptSpan } from "../src/text";

/** A lone surrogate anywhere in `s` (providers reject them). */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `@<offset> ` prefix of an excerpt, or 0 without one. */
const offsetOf = (e: string) => Number(/^@(\d+) /.exec(e)?.[1] ?? 0);

/** 10 000 log lines, "step 0 ok" … "step 9999 ok", with line 5998 failing. */
function stepLog(): string {
  const lines: string[] = [];
  for (let i = 0; i < 10_000; i++) lines.push(i === 5998 ? "step 5998 failed: disk full" : `step ${i} ok`);
  return lines.join("\n");
}

describe("excerpt", () => {
  it("M07: a multi-word query is excerpted where the whole phrase occurs, with the offset to read it from", () => {
    const log = stepLog();
    expect(log.length).toBeGreaterThan(100_000);
    const e = excerpt(log, ["step", "5998"], 80, { phrase: "step 5998" });
    expect(e).toMatch(/^@\d+ …/);
    expect(e).toContain("step 5998 failed: disk full");
    expect(e).not.toContain("step 1 ok");
    const offset = offsetOf(e);
    expect(offset).toBe(excerptSpan(log, ["step", "5998"], 80, "step 5998")!.start);
    // Reading from the offset (read_resource counts the same UTF-16 units) shows the line.
    expect(log.slice(offset, offset + 200)).toContain("step 5998 failed");
    // The phrase is matched case-insensitively and across any whitespace.
    expect(excerpt(log.replace("step 5998", "Step\n  5998"), ["STEP", "5998"], 80, { phrase: "STEP 5998" })).toContain("Step 5998 failed");
  });

  it("M07: without a phrase the window holding both words wins over the first occurrence of either", () => {
    const log = stepLog();
    // "step" occurs 10 000 times (only its first 2 000 anchor windows, but it is still seen beside "5998").
    const e = excerpt(log, ["step", "5998"]);
    expect(e).toContain("step 5998 failed");
    expect(offsetOf(e)).toBeGreaterThan(50_000);
    // A rare word and a frequent word that never share a window: the rare one, frequent words first or not.
    const apart = `${"step ok\n".repeat(3_000)}${"-".repeat(400)} 5998 failed ${"-".repeat(400)}`;
    expect(excerpt(apart, ["step", "5998"])).toContain("5998 failed");
  });

  it("picks the window holding the most distinct words when they never appear side by side", () => {
    const f = "-".repeat(300);
    const text = `alpha ${f} beta ${f} gamma ${f} alpha and some gamma then beta ${f} beta gamma`;
    const e = excerpt(text, ["alpha", "beta", "gamma"], 80, { phrase: "alpha beta gamma" });
    expect(e).toContain("alpha and some gamma then beta");
    const at = text.indexOf("alpha and");
    const offset = offsetOf(e);
    expect(offset).toBeGreaterThan(0);
    // Centred on the cluster: as much context before it as after it.
    const span = excerptSpan(text, ["alpha", "beta", "gamma"])!;
    expect(span.start).toBe(offset);
    const cluster = "alpha and some gamma then beta".length;
    expect(Math.abs(at - span.start - (span.end - (at + cluster)))).toBeLessThanOrEqual(1);
  });

  it("breaks ties on distinct words by the rarest word, then by position", () => {
    const f = "-".repeat(400);
    // {foo, baz} first, {foo, bar} later: both hold two words, but bar occurs once and baz three times.
    const text = `foo baz ${f} baz ${f} baz ${f} foo bar ${f}`;
    expect(excerpt(text, ["foo", "bar", "baz"])).toContain("foo bar");
    // One word only, everywhere: the earliest occurrence.
    const text2 = `${f} qux one ${f} qux two ${f}`;
    const e2 = excerpt(text2, ["qux"]);
    expect(e2).toContain("qux one");
    expect(e2).not.toContain("qux two");
    // Equally rare words, never together: the earliest.
    const e3 = excerpt(`${f} left ${f} right ${f}`, ["right", "left"]);
    expect(e3).toContain("left");
    expect(e3).not.toContain("right");
  });

  it("handles Chinese queries: the phrase first, else the window with both words", () => {
    const filler = "无关的内容。".repeat(60);
    const text = `报价单模板说明。${filler}供应商 C 的报价单已经含税，${filler}最后一次提到含税。`;
    const e = excerpt(text, ["报价单", "含税"], 40, { phrase: "报价单 含税" });
    expect(e).toContain("报价单已经含税");
    expect(text.slice(offsetOf(e), offsetOf(e) + 100)).toContain("报价单已经含税");
    // The whole phrase, also across a line break, beats the densest window.
    const withPhrase = `${text}${filler}报价单\n含税的说明`;
    expect(excerpt(withPhrase, ["报价单", "含税"], 40, { phrase: "报价单 含税" })).toContain("报价单 含税的说明");
  });

  it("reports the offset only when the excerpt does not start at the beginning of the document", () => {
    const text = "needle at the start, then a long tail " + "z".repeat(500);
    expect(excerpt(text, ["needle"])).toMatch(/^needle at the start/);
    expect(excerpt("short text with needle", ["needle"])).toBe("short text with needle");
    // No word found: the beginning, on one line, no offset.
    expect(excerpt(`a\n\nb ${"z".repeat(500)}`, ["absent"], 10)).toBe(`a b ${"z".repeat(15)}…`);

    const doc = `${"z".repeat(500)} needle ${"z".repeat(500)}`;
    const e = excerpt(doc, ["needle"]);
    const offset = offsetOf(e);
    expect(e.startsWith(`@${offset} …`)).toBe(true);
    expect(e.slice(`@${offset} …`.length)).toBe(doc.slice(offset, offset + 166) + "…");

    // origin: the document the offset counts in starts later in the text (a note's `description\nbody`).
    const description = "a note about pins";
    const body = `${"y".repeat(300)} needle ${"y".repeat(300)}`;
    const noted = excerpt(`${description}\n${body}`, ["needle"], 80, { origin: description.length + 1 });
    expect(body.slice(offsetOf(noted), offsetOf(noted) + 100)).toContain("needle");
    // A match in the description itself: no offset into the body.
    expect(excerpt(`${description}\n${body}`, ["note"], 80, { origin: description.length + 1 })).toMatch(/^a note about/);
    // origin false: never an offset.
    expect(excerpt(doc, ["needle"], 80, { origin: false })).toMatch(/^…z+ needle z+…$/);
  });

  it("never splits a surrogate pair at either end", () => {
    // Emoji are two UTF-16 units: high surrogates at odd indices, low surrogates at even ones (after the leading "a").
    const text = `a${"😀".repeat(100)}needle${"😀".repeat(100)}`;
    // radius 5: the raw window [196, 212) would start on a low surrogate and end after a high one.
    expect(excerptSpan(text, ["needle"], 5)).toEqual({ start: 197, end: 211 });
    expect(excerpt(text, ["needle"], 5)).toBe("@197 …😀😀needle😀😀…");
    for (let shift = 0; shift < 4; shift++) {
      const t = `${"a".repeat(shift)}${"😀".repeat(100)}needle 😀 ${"😀".repeat(100)}`;
      for (let radius = 1; radius < 12; radius++) {
        for (const e of [excerpt(t, ["needle"], radius), excerpt(t, ["needle", "😀"], radius, { phrase: "needle 😀" })]) {
          expect(e).toContain("needle");
          expect(loneSurrogate.test(e)).toBe(false);
        }
      }
    }
    // Matches near both ends of the text, and the no-match fallback.
    for (const e of [excerpt(text, ["a"], 3), excerpt(`${text}z`, ["z"], 3), excerpt(text, ["absent"], 3)]) {
      expect(loneSurrogate.test(e)).toBe(false);
    }
  });

  it("stays linear on long texts, and sees frequent words beyond the anchors they are capped at", () => {
    const text = "error retry ".repeat(50_000) + "error timeout";
    expect(text.length).toBeGreaterThan(500_000);
    const t0 = performance.now();
    expect(excerpt(text, ["error", "retry", "timeout"], 80, { phrase: "error timeout" })).toMatch(/error timeout$/);
    // No phrase: "error" and "retry" sit together everywhere, but only the end holds all three words.
    expect(excerpt(text, ["error", "retry", "timeout"])).toMatch(/^@\d+ …[a-z ]*retry error timeout$/);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
