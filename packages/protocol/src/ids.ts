import { randomBytes } from "node:crypto";
import { systemClock, type Clock } from "./clock";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

let lastTime = -1;
let counter = 0;

function encodeTime(ms: number): string {
  let out = "";
  let n = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeCounter(n: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out = ALPHABET[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function randomPart(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 32]!;
  return out;
}

/**
 * Time-sortable id: `<prefix>_<10 time chars><4 counter chars><8 random chars>`.
 * Ids generated in this process sort in creation order even within one millisecond or if the clock steps back.
 */
export function newId(prefix: string, clock: Clock = systemClock): string {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) throw new Error(`newId: invalid prefix "${prefix}" (use lowercase letters/digits)`);
  let t = clock.now();
  if (t <= lastTime) {
    t = lastTime;
    counter++;
    if (counter >= 32 ** 4) {
      t = lastTime + 1;
      counter = 0;
    }
  } else {
    counter = 0;
  }
  lastTime = t;
  return `${prefix}_${encodeTime(t)}${encodeCounter(counter)}${randomPart(8)}`;
}
