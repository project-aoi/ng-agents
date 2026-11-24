import { Fragment, useMemo, type ReactNode } from "react";
import { useOpenReport } from "../state";

// Read-only Markdown for reports, replies and project notes. Builds React elements (never HTML strings), so nothing in
// the text can inject markup. Covers what agents actually write: headings, paragraphs, lists (nested, tasks), fenced
// code, block quotes (with `> [!DECISION]` callouts), tables, rules, and inline code / bold / italic / strike / links.
// Code and paths are shown verbatim in monospace.

type Align = "left" | "right" | "center" | null;

export type MdBlock =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; children: MdBlock[] }
  | { t: "list"; ordered: boolean; start: number; items: Array<{ task: boolean | null; children: MdBlock[] }> }
  | { t: "hr" }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] };

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function blank(l: string): boolean {
  return l.trim() === "";
}

function indentOf(l: string): number {
  return l.length - l.trimStart().length;
}

function startsBlock(l: string): boolean {
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l);
}

function splitRow(l: string): string[] {
  const s = l.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseBlocks(lines: readonly string[]): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const close = new RegExp(`^\\s{0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) {
        const l = lines[i]!;
        body.push(l.slice(Math.min(indent, indentOf(l))));
        i++;
      }
      i++;
      out.push({ t: "code", lang: fence[3] ?? "", text: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      out.push({ t: "quote", children: parseBlocks(inner) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const base = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const items: Array<{ task: boolean | null; children: MdBlock[] }> = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || Math.abs(m[1]!.length - base) > 1 || /\d/.test(m[2]!) !== ordered) break;
        const contentIndent = m[1]!.length + m[2]!.length + 1;
        const body: string[] = [m[3]!];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (blank(l)) {
            let j = i + 1;
            while (j < lines.length && blank(lines[j]!)) j++;
            if (j < lines.length && indentOf(lines[j]!) >= contentIndent) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(l) >= contentIndent) {
            body.push(l.slice(contentIndent));
          } else if (ITEM.test(l) && indentOf(l) > base + 1) {
            // A nested list indented less than the parent's text ("- a\n  - b" under "1. a").
            body.push(l.slice(Math.min(indentOf(l), base + 2)));
          } else if (startsBlock(l)) {
            break;
          } else {
            body.push(l.trim()); // lazy continuation of the item's paragraph
          }
          i++;
        }
        const task = /^\[([ xX])\]\s+/.exec(body[0] ?? "");
        if (task) body[0] = body[0]!.slice(task[0].length);
        items.push({ task: task ? task[1] !== " " : null, children: parseBlocks(body) });
        // Blank lines between sibling items keep the list going.
        let j = i;
        while (j < lines.length && blank(lines[j]!)) j++;
        const next = j < lines.length ? ITEM.exec(lines[j]!) : null;
        if (next && Math.abs(next[1]!.length - base) <= 1 && /\d/.test(next[2]!) === ordered) i = j;
      }
      out.push({ t: "list", ordered, start: ordered ? Number.parseInt(item[2]!, 10) || 1 : 1, items });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push({ t: "table", head, align, rows });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]!) && !startsBlock(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ t: "p", lines: para });
  }
  return out;
}

// ==================== inline ====================

// Groups: 1 escaped char · 2,3 code · 4,5 link · 6 autolink · 7 bare url · 8,9 bold · 10 strike · 11,12 italic
// (underscore emphasis only at word edges, so snake_case identifiers stay intact).
const INLINE =
  /\\([\\`*_{}\[\]()#+\-.!~|>])|(`+)([\s\S]*?[^`])\2(?!`)|\[([^\]]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|(https?:\/\/[^\s<>()（）]*[^\s<>()（）.,;:!?，。；：！？、"'”’])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*](?:[\s\S]*?[^\s*])?)\*|(?<![\p{L}\p{N}_])_([^\s_](?:[\s\S]*?[^\s_])?)_(?![\p{L}\p{N}_])/gu;

function safeHref(url: string): string | null {
  return /^(?:https?:\/\/|mailto:)/i.test(url) ? url : null;
}

/** A report or draft of the workbench named in a text (`[标题](artifact://…)`): opens it, never shows its address. */
function ReportLink({ artifactId, title }: { artifactId: string; title: string }) {
  const openReport = useOpenReport();
  return (
    <button type="button" className="link-btn" onClick={() => openReport({ artifactId, title, version: 0, updatedAt: 0 })}>
      {title}
    </button>
  );
}

/** A text with its links reduced to their words — for one-line places that render no Markdown. */
export function plainLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(\s*[a-z][a-z0-9+.-]*:\/\/[^)\s]*\s*\)/gi, "《$1》");
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

export function renderInline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  // A fresh regex per call: this recurses into bold/italic/link text.
  const re = new RegExp(INLINE.source, INLINE.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[3] !== undefined) out.push(<code key={k}>{m[3].replace(/^ (.+) $/, "$1")}</code>);
    else if (m[4] !== undefined) {
      const href = safeHref(m[5]!);
      const report = /^artifact:\/\/([A-Za-z0-9_-]+)/.exec(m[5]!);
      out.push(
        report ? (
          <ReportLink key={k} artifactId={report[1]!} title={m[4]} />
        ) : href ? (
          <ExternalLink key={k} href={href}>
            {renderInline(m[4], k)}
          </ExternalLink>
        ) : (
          <Fragment key={k}>{renderInline(m[4], k)}</Fragment>
        ),
      );
    } else if (m[6] !== undefined || m[7] !== undefined) {
      const url = (m[6] ?? m[7])!;
      out.push(
        <ExternalLink key={k} href={url}>
          {url}
        </ExternalLink>,
      );
    } else if (m[8] !== undefined || m[9] !== undefined) out.push(<strong key={k}>{renderInline((m[8] ?? m[9])!, k)}</strong>);
    else if (m[10] !== undefined) out.push(<del key={k}>{renderInline(m[10], k)}</del>);
    else if (m[11] !== undefined || m[12] !== undefined) out.push(<em key={k}>{renderInline((m[11] ?? m[12])!, k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ==================== blocks → elements ====================

const CALLOUT = /^\[!([A-Za-z一-鿿]+)\]\s*(.*)$/;
const CALLOUT_LABEL: Record<string, string> = { DECISION: "需要你拍板", 决策: "需要你拍板", NOTE: "注", TIP: "提示", IMPORTANT: "重要", WARNING: "注意", CAUTION: "注意" };

function lines(ls: readonly string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  ls.forEach((l, i) => {
    if (i > 0) out.push(<br key={`${key}.br${i}`} />);
    out.push(...renderInline(l, `${key}.${i}`));
  });
  return out;
}

function renderBlocks(blocks: readonly MdBlock[], key: string, tight = false): ReactNode[] {
  return blocks.map((b, idx) => {
    const k = `${key}.${idx}`;
    switch (b.t) {
      case "h": {
        const Tag = `h${Math.min(6, b.level)}` as "h1";
        return <Tag key={k}>{renderInline(b.text, k)}</Tag>;
      }
      case "p":
        // A list item's own first line is not a separate paragraph (its nested list or code follows it).
        return tight && idx === 0 ? <Fragment key={k}>{lines(b.lines, k)}</Fragment> : <p key={k}>{lines(b.lines, k)}</p>;
      case "code":
        return (
          <pre key={k} className="md-code" data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case "quote": {
        const first = b.children[0];
        const head = first?.t === "p" ? CALLOUT.exec(first.lines[0] ?? "") : null;
        if (head && first?.t === "p") {
          const kind = head[1]!;
          const rest: MdBlock[] = first.lines.length > 1 ? [{ t: "p", lines: first.lines.slice(1) }, ...b.children.slice(1)] : b.children.slice(1);
          const label = head[2] ? head[2] : (CALLOUT_LABEL[kind.toUpperCase()] ?? CALLOUT_LABEL[kind] ?? kind);
          return (
            <blockquote key={k} className={`md-callout${/^(DECISION|决策)$/i.test(kind) ? " decision" : ""}`}>
              <p className="md-callout-label">{renderInline(label, `${k}.l`)}</p>
              {renderBlocks(rest, k)}
            </blockquote>
          );
        }
        return <blockquote key={k}>{renderBlocks(b.children, k)}</blockquote>;
      }
      case "list": {
        const items = b.items.map((it, j) => (
          <li key={`${k}.${j}`} className={it.task === null ? undefined : "md-task"}>
            {it.task !== null && <input type="checkbox" checked={it.task} readOnly disabled aria-label={it.task ? "已完成" : "未完成"} />}
            {renderBlocks(it.children, `${k}.${j}`, true)}
          </li>
        ));
        return b.ordered ? (
          <ol key={k} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case "hr":
        return <hr key={k} />;
      case "table":
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                      {renderInline(c, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, j) => (
                      <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                        {renderInline(r[j] ?? "", `${k}.${ri}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const nodes = useMemo(() => renderBlocks(parseBlocks(text.replace(/\r\n?/g, "\n").split("\n")), "md"), [text]);
  return <div className={`md${className ? ` ${className}` : ""}`}>{nodes}</div>;
}
