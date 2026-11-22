// @ng/protocol — the shared contract: docs/02 §二 verbatim + IMPL_BRIEF §2.6 extensions, GTD record conventions,
// the SQLite layer and schema, repo helpers, bus, clock and ids. No I/O other than SQLite.

// ---- contract (docs/02 §二) ----
export * from "./contract/envelope";
export * from "./contract/deliverable";
export * from "./contract/channel";
export * from "./contract/inbox";
export * from "./contract/context";
export * from "./contract/model";
export * from "./contract/loop";
export * from "./contract/workspace";
export * from "./contract/gate";
export * from "./contract/cell";

// ---- helpers ----
export * from "./address";
export * from "./bounds";
export * from "./registry";
export * from "./payloads";
export * from "./gtd";
export * from "./bus";
export * from "./clock";
export * from "./ids";
export * from "./errors";
export * from "./json";
export * from "./process";

// ---- SQLite ----
export * from "./db/sqlite";
export * from "./db/repos";
export * from "./schema";
export * from "./human-item";

export {CHANNEL_LABELS,describeEnvelopeSource} from "./source";
