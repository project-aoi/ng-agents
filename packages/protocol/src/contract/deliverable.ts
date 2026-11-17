import { z } from "zod";

export interface DeliverableAttachment {
  label: string;
  uri: string;
}

/**
 * Anything shown to a human or sent outward: reply drafts, proposals, approval cards, notifications.
 * - `body` is always a human-readable rendering (markdown for "markdown", JSON text for "json",
 *   a plain-text fallback for "card"), so a channel that only speaks text can always send `body`.
 * - `data` carries the structured value: the parsed JSON for "json", a `ClarifyCard` (see gtd.ts) for "card".
 */
export interface Deliverable {
  format: "text" | "markdown" | "json" | "card";
  title?: string;
  body: string;
  data?: unknown;
  attachments?: DeliverableAttachment[];
}

export type DeliverableFormat = Deliverable["format"];

export const deliverableSchema = z.object({
  format: z.enum(["text", "markdown", "json", "card"]),
  title: z.string().optional(),
  body: z.string(),
  data: z.unknown().optional(),
  attachments: z.array(z.object({ label: z.string(), uri: z.string() })).optional(),
});

export function textDeliverable(body: string, title?: string): Deliverable {
  return title === undefined ? { format: "text", body } : { format: "text", title, body };
}

export function markdownDeliverable(body: string, title?: string): Deliverable {
  return title === undefined ? { format: "markdown", body } : { format: "markdown", title, body };
}
