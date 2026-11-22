import {
  mergeAdjacentMessages,
  type ModelMessage,
  type PromptSnapshot,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@ng/protocol";

/**
 * The message list of one Run: `mergeAdjacentMessages([...history, ...tail])` from the snapshot, then append-only.
 * Steer notes and tool results are appended in the same order Context will rebuild them from evidence, so the next
 * Run's history matches what the model saw here.
 */
export class Conversation {
  readonly messages: ModelMessage[];
  /** Last block of the snapshot's history inside `messages` (prompt-cache breakpoint), if there is history. */
  readonly stablePrefixEnd: { message: number; block: number } | undefined;

  private constructor(messages: ModelMessage[], stablePrefixEnd: { message: number; block: number } | undefined) {
    this.messages = messages;
    this.stablePrefixEnd = stablePrefixEnd;
  }

  static fromSnapshot(snapshot: PromptSnapshot): Conversation {
    const merged = mergeAdjacentMessages([...snapshot.history, ...snapshot.tail.messages]);
    // mergeAdjacentMessages keeps block identity, so the history's last block can be located after merging.
    const lastHistoryBlock = snapshot.history[snapshot.history.length - 1]?.content.at(-1);
    let stable: { message: number; block: number } | undefined;
    if (lastHistoryBlock) {
      for (let i = merged.length - 1; i >= 0 && !stable; i--) {
        const j = merged[i]!.content.indexOf(lastHistoryBlock);
        if (j >= 0) stable = { message: i, block: j };
      }
    }
    return new Conversation(merged, stable);
  }

  get lastRole(): "user" | "assistant" | undefined {
    return this.messages[this.messages.length - 1]?.role;
  }

  appendUserText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") last.content = [...last.content, { type: "text", text }];
    else this.messages.push({ role: "user", content: [{ type: "text", text }] });
  }

  appendAssistant(content: Array<TextBlock | ToolUseBlock>): void {
    const msg: ModelMessage = { role: "assistant", content: content.length ? [...content] : [{ type: "text", text: "" }] };
    this.messages.push(msg);
  }

  appendToolResults(results: ToolResultBlock[]): void {
    if (results.length) this.messages.push({ role: "user", content: [...results] });
  }

  /** A copy safe to hand to a client (later appends do not show up in recorded requests). */
  forRequest(): ModelMessage[] {
    return this.messages.map((m) => ({ ...m, content: [...m.content] }));
  }
}
