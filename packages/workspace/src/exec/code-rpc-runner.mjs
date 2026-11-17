// Runs inside the code_rpc child, started as `node --permission --input-type=module -e <this file's text>`.
// With --permission and no --allow-* grants the child cannot touch the filesystem, spawn processes or start
// workers; everything it does to the outside goes through `tools.*`, which the host executes.
// Protocol: one JSON object per line. Host -> child on stdin: {t:"start", code, rpcList} then {t:"result", id, ok,
// value | error}. Child -> host on stdout, each line prefixed by SENTINEL: {t:"out", s} | {t:"call", id, tool, args}
// | {t:"done", ok, error?}. stdout/stderr writes by user code are captured into "out" messages.

const SENTINEL = "\u0001ngrpc\u0001";
const rawWrite = process.stdout.write.bind(process.stdout);
const send = (msg) => rawWrite(SENTINEL + JSON.stringify(msg) + "\n");

const capture = (chunk, encoding, cb) => {
  const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
  if (s) send({ t: "out", s });
  const done = typeof encoding === "function" ? encoding : cb;
  if (typeof done === "function") done();
  return true;
};
process.stdout.write = capture;
process.stderr.write = capture;

let nextId = 1;
const pending = new Map();
const call = (tool, args) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: "call", id, tool, args: args === undefined ? null : args });
  });

let started = false;
const start = async (msg) => {
  const rpcList = Array.isArray(msg.rpcList) ? msg.rpcList : [];
  globalThis.tools = Object.freeze({
    read: (args) => call("read", args),
    write: (args) => call("write", args),
    edit: (args) => call("edit", args),
    bash: (args) => call("bash", typeof args === "string" ? { command: args } : args),
    readFile: async (path) => (await call("read", { op: "read_file", path })).output,
    search: (pattern, opts) => call("read", { op: "search", pattern, ...(opts || {}) }),
    http: (req) => call("http", req),
    rpc: (name, args) => call("rpc", { name, args }),
    rpcList,
  });
  try {
    await import("data:text/javascript;base64," + Buffer.from(String(msg.code), "utf8").toString("base64"));
    send({ t: "done", ok: true });
  } catch (e) {
    const err = e && typeof e === "object" ? `${e.name || "Error"}: ${e.message}` : String(e);
    send({ t: "done", ok: false, error: err });
  }
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.t === "start" && !started) {
      started = true;
      void start(msg);
    } else if (msg.t === "result") {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(String(msg.error)));
    }
  }
});
