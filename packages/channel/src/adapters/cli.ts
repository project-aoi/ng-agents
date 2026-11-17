import { createInterface, type Interface } from "node:readline";
import { PAYLOAD, newId, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import type { DeliveryRequest, DeliveryResult } from "../types";
import { errorMessage, renderText } from "../util";

export const CLI_CHANNEL_ID = "cli";
export const CLI_TARGET = "console";

export interface CliChannelOptions extends Partial<Pick<BaseChannelOptions, "id" | "clock" | "ownerPrincipal" | "sendTimeoutMs">> {
  input?: NodeJS.ReadableStream;        // default process.stdin
  output?: NodeJS.WritableStream;       // default process.stdout
}

/**
 * Local terminal: each input line is a `user.message` from the owner; sends and preview chunks go to stdout.
 * Lines are handed to the hub one at a time, in order, each awaited until durably enqueued.
 */
export class CliChannel extends BaseChannel {
  readonly kind = "cli";
  readonly capabilities = { idempotentSend: false, withdrawOrEdit: false, streamingPreview: true } as const;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  #rl: Interface | null = null;
  #chain: Promise<void> = Promise.resolve();
  #midLine = false;

  constructor(opts: CliChannelOptions = {}) {
    super({ ...opts, id: opts.id ?? CLI_CHANNEL_ID });
    this.#input = opts.input ?? process.stdin;
    this.#output = opts.output ?? process.stdout;
  }

  start(): void {
    if (this.#rl) return;
    const rl = createInterface({ input: this.#input, terminal: false });
    rl.on("line", (line) => {
      this.#chain = this.#chain.then(() => this.#ingestLine(line));
    });
    rl.on("close", () => {
      if (this.#rl === rl) this.#rl = null;
    });
    this.#rl = rl;
  }

  stop(): void {
    this.#rl?.close();
    this.#rl = null;
  }

  /** Resolves when every line read so far has been handed to the hub. */
  idle(): Promise<void> {
    return this.#chain;
  }

  protected override state() {
    return this.#rl ? { state: "ready" as const } : { state: "stopped" as const, detail: "not reading input" };
  }

  async #ingestLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    const replyTo = this.addr(CLI_TARGET);
    const payload: UserMessagePayload = { text, replyTo, sender: { id: this.ownerPrincipal } };
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(newId("line", this.clock)),
      from: replyTo,
      principalId: this.ownerPrincipal,
      kind: "event",
      type: PAYLOAD.userMessage,
      payload,
      createdAt: this.clock.now(),
    };
    try {
      await this.emitIngress(env);
    } catch (err) {
      await this.#write(`${this.#midLine ? "\n" : ""}! 未能保存这条消息：${errorMessage(err)}\n`).catch(() => undefined);
      this.#midLine = false;
    }
  }

  #write(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#output.write(text, (err) => (err ? reject(err) : resolve()));
    });
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    const text = `${this.#midLine ? "\n" : ""}${renderText(req.content)}\n`;
    try {
      await this.#write(text);
      this.#midLine = false;
      return { status: "sent" };
    } catch (err) {
      return { status: "failed", error: `stdout write failed: ${errorMessage(err)}` };
    }
  }

  async streamPreview(_target: string, chunk: string): Promise<void> {
    if (!chunk) return;
    await this.#write(chunk);
    this.#midLine = !chunk.endsWith("\n");
  }
}
