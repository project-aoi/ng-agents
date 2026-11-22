// @ng/channel — primitive ①: external ingress, idempotent sends with honest receipts, and the Engage DND buffer.
// The kernel and the app talk to `createChannelHub`; adapters are thin transports registered on it.

export { createChannelHub } from "./hub";
export type {
  ChannelHubImpl,
  ChannelHubOptions,
  EditReceipt,
  FlushReceipt,
  FlushResult,
  IngressSink,
  PrepareSendReceipt,
  PrepareSendResult,
  PreparedSendAttempt,
  ResolveUnknownResult,
} from "./hub";
export { BaseChannel } from "./base";
export type { BaseChannelOptions } from "./base";
export * from "./types";
export { DEFAULT_SEND_TIMEOUT_MS, renderText } from "./util";

export { UiChannel, UI_CHANNEL_ID, UI_OWNER_TARGET } from "./adapters/ui";
export type { CaptureInput, UiChannelOptions } from "./adapters/ui";
export { CliChannel, CLI_CHANNEL_ID, CLI_TARGET } from "./adapters/cli";
export type { CliChannelOptions } from "./adapters/cli";
export { MemoryChannel } from "./adapters/memory";
export type { InjectInput, MemoryChannelOptions, MemoryDelivery, MemoryEdit, MemoryOutcome } from "./adapters/memory";
export { WebhookChannel } from "./adapters/webhook";
export type { WebhookChannelOptions, WebhookMapped } from "./adapters/webhook";
export { GithubChannel } from "./adapters/github";
export type { GithubChannelOptions } from "./adapters/github";
export { SlackChannel } from "./adapters/slack";
export type { SlackChannelOptions } from "./adapters/slack";
export { FeishuChannel, feishuDecrypt, feishuSignature, feishuUuid } from "./adapters/feishu";
export type { FeishuChannelOptions } from "./adapters/feishu";
