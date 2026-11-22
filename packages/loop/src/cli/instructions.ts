import type { ToolDef } from "@ng/protocol";
import type { CliAdapter, CliCapabilities } from "./types";

export const CLI_MCP_SERVER = "ng";

/**
 * What a CLI agent must know about being a cell, appended to the cell's frozen system text: a coding CLI arrives with
 * its own habits (its own way of asking the user, a task list nobody sees), so this says which of them do not apply
 * and where the kernel's tools take over. Its own sub-agents are its own business: they run inside this cell's
 * process and are welcome — what a cell may not do is ask a terminal nobody is sitting at.
 */
export function kernelSystem(frozen: string, adapter: CliAdapter, caps: CliCapabilities, tools: readonly ToolDef[]): string {
  const example = tools[0] ? adapter.mcpToolName(CLI_MCP_SERVER, tools[0].name) : adapter.mcpToolName(CLI_MCP_SERVER, "set_state");
  const directory = caps.readOnly
    ? `- Directory: \`${caps.root}\`. This workspace is read-only (its tool permissions allow reading and searching only). ${adapter.readOnlyHowTo(caps)}`
    : `- Directory: \`${caps.root}\`. You work with this CLI's own file and shell tools, as you normally would, on the owner's real machine with no sandbox — the red lines above are the only guard, so keep to them. Nothing reserves this directory for you: another cell, or the owner, may be working in it at the same time.`;
  const lines = [
    frozen.trimEnd(),
    "",
    "## How this cell runs",
    `- Kernel tools: the MCP server "${CLI_MCP_SERVER}" provides them (${tools.map((t) => t.name).join(", ") || "none"}); this client names them like ${example}. They are how what you do reaches the rest of the workbench: reports, waits, messages to cells and people, state, artifacts, reminders, background jobs. Tool names in your instructions (report_to_parent, wait, send_message, …) mean these. Reading files, editing and running commands are not their job — that is what this CLI's own tools are for.`,
    directory,
    "- Nobody is at this terminal. Never use this CLI's ask-the-user or plan-approval features: a question put there blocks the run and is never answered. To ask the owner something, use the kernel tools, or simply say it in your reply when the owner is talking to you directly. This CLI's own sub-agents are yours to use for your own work; other cells are reached only through the kernel tools.",
    "- When a kernel tool result says the run has ended, stop at once: no further tool calls, no further work, no closing summary.",
  ];
  return lines.join("\n");
}
