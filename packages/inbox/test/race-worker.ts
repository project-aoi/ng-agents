// Runs in a worker thread (loaded through tsx): one OS thread, one SQLite connection, one Inbox — racing the others.
import { parentPort, workerData } from "node:worker_threads";
import { createBus, openDatabase, systemClock } from "@ng/protocol";
import { createInbox } from "../src";

interface RaceInput {
  path: string;
  cellId: string;
  workerId: string;
  /** messages this thread enqueues while racing (producers and consumers interleave) */
  produce: number;
  /** messages expected in total (preloaded + produced by all threads) */
  total: number;
  /** Int32 slots: [0] start barrier, [1] claims currently held, [2] max held at once, [3] messages completed */
  shared: SharedArrayBuffer;
}

const input = workerData as RaceInput;
const flags = new Int32Array(input.shared);
const db = openDatabase(input.path, { busyTimeoutMs: 30_000 });
const inbox = createInbox({ db, bus: createBus(), clock: systemClock });

Atomics.wait(flags, 0, 0); // everyone starts together

const napSlot = new Int32Array(new SharedArrayBuffer(4));
// SQLite's busy handler favours the connection that just released the lock; a short random nap between attempts
// gives every thread a real chance to win claims, so the overlap check below has teeth.
const nap = () => Atomics.wait(napSlot, 0, 0, Math.random() * 2);

const claimed: number[] = [];
let batches = 0;
let produced = 0;
for (; Atomics.load(flags, 3) < input.total; nap()) {
  if (produced < input.produce) {
    inbox.enqueueSync(input.cellId, {
      id: `${input.workerId}-${produced++}`,
      from: "channel:test:race",
      principalId: "owner",
      kind: "event",
      type: "user.message",
      payload: { text: "race" },
      createdAt: Date.now(),
    });
  }
  const batch = inbox.claimNextRunSync(input.cellId, input.workerId, 60_000);
  if (!batch) continue;
  batches++;
  const held = Atomics.add(flags, 1, 1) + 1;
  let max = Atomics.load(flags, 2);
  while (held > max && Atomics.compareExchange(flags, 2, max, held) !== max) max = Atomics.load(flags, 2);
  claimed.push(...batch.seqs);
  // hold the claim for a moment so overlapping claims would be observable
  const until = Date.now() + 1;
  while (Date.now() < until) {
    /* spin */
  }
  Atomics.sub(flags, 1, 1);
  inbox.completeSync(batch.claimId);
  Atomics.add(flags, 3, batch.seqs.length);
}

db.close();
parentPort!.postMessage({ claimed, batches });
