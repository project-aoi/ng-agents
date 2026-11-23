FX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$FX"/lib.sh; mkdir -p ~/dev/tui-table/{src,test}; cd ~/dev/tui-table
cat > package.json <<'T'
{ "name": "tui-table", "version": "0.3.0", "type": "module", "scripts": { "test": "node --test", "lint": "node --check src/table.js && node --check src/copy.js" } }
T
cat > src/table.js <<'T'
import { wrap, stripAnsi, width } from "./text.js";
/** Render rows as a box table; returns the screen lines. */
export function render(rows, { widths, header = true } = {}) {
  const w = widths ?? rows[0].map((_, c) => Math.max(...rows.map((r) => width(String(r[c] ?? "")))));
  const line = (cells) => `│${cells.map((c, i) => ` ${c}${" ".repeat(Math.max(0, w[i] - width(c)))} `).join("│")}│`;
  const out = [];
  rows.forEach((r, y) => {
    const cols = r.map((c, i) => wrap(String(c ?? ""), w[i]));
    const h = Math.max(...cols.map((c) => c.length));
    for (let k = 0; k < h; k++) out.push(line(cols.map((c) => c[k] ?? "")));
    if (y === 0 && header) out.push(`├${w.map((n) => "─".repeat(n + 2)).join("┼")}┤`);
  });
  return out;
}
export { stripAnsi };
T
cat > src/text.js <<'T'
const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s) => s.replace(ANSI, "");
export const width = (s) => [...stripAnsi(s)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
export function wrap(s, w) {
  if (width(s) <= w) return [s];
  const out = []; let cur = ""; let n = 0;
  for (const ch of stripAnsi(s)) { const cw = width(ch); if (n + cw > w) { out.push(cur); cur = ""; n = 0; } cur += ch; n += cw; }
  if (cur) out.push(cur); return out;
}
T
cat > src/copy.js <<'T'
import { render } from "./table.js";
/** Text put on the clipboard for a selected block of rows (y0..y1) and columns (x0..x1), inclusive. */
export function copySelection(rows, sel, opts = {}) {
  const part = rows.slice(sel.y0, sel.y1 + 1).map((r) => r.slice(sel.x0, sel.x1 + 1));
  return render(part, { ...opts, header: false, widths: opts.widths?.slice(sel.x0, sel.x1 + 1) }).join("\n");
}
T
cat > test/copy.test.js <<'T'
import test from "node:test"; import assert from "node:assert/strict"; import { copySelection } from "../src/copy.js";
test("copies one cell", () => { assert.match(copySelection([["a", "b"], ["c", "d"]], { x0: 1, y0: 1, x1: 1, y1: 1 }), /d/); });
T
cat > test/table.test.js <<'T'
import test from "node:test"; import assert from "node:assert/strict"; import { render } from "../src/table.js";
test("renders a header rule", () => { assert.equal(render([["k", "v"], ["a", "1"]])[1], "├───┼───┤"); });
T
printf '# tui-table\nTable widget for terminal UIs. `npm test` runs the tests, `npm run lint` the checks.\nMRs: push a feature branch, then `forge mr create --branch <b> --title <t>`; `forge ci status <n>`; a maintainer merges.\n' > README.md; repo tui-table
