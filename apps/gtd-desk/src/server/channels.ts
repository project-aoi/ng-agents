import { FeishuChannel, GithubChannel, SlackChannel, WebhookChannel, type SecretProvider } from "@ng/channel";
import type { SecretStore } from "@ng/gate";
import type { Channel, Clock } from "@ng/protocol";
import type { Env } from "./backend";

/**
 * Secret refs the external channels read from the kernel's secret store (default store: `NG_SECRET_<REF>` env vars,
 * e.g. `github.webhook` → NG_SECRET_GITHUB_WEBHOOK). A channel is mounted only when its inbound secret is present;
 * values are resolved per request and never copied into configuration.
 */
export const CHANNEL_SECRETS = {
  webhook: { signing: "webhook.signing" },
  github: { webhook: "github.webhook", token: "github.token" },
  slack: { signing: "slack.signing", bot: "slack.bot" },
  feishu: { verification: "feishu.verification", encrypt: "feishu.encrypt", tenant: "feishu.tenant" },
} as const;

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function provider(secrets: SecretStore, ref: string): SecretProvider {
  return () => {
    const v = secrets.get(ref);
    if (!v) throw new Error(`secret "${ref}" is not configured`);
    return v;
  };
}

function optional(secrets: SecretStore, ref: string): SecretProvider | undefined {
  return secrets.has(ref) ? provider(secrets, ref) : undefined;
}

export interface ChannelConfig {
  channels: Channel[];
  /** Human-readable summary for the startup log (no secret values). */
  summary: string[];
}

export function channelsFromEnv(env: Env, secrets: SecretStore, clock: Clock, ownerPrincipal: string): ChannelConfig {
  const channels: Channel[] = [];
  const summary: string[] = [];
  const base = { clock, ownerPrincipal };

  if (secrets.has(CHANNEL_SECRETS.webhook.signing)) {
    const id = env["NG_WEBHOOK_ID"] || "webhook";
    const url = env["NG_WEBHOOK_URL"];
    channels.push(new WebhookChannel({ ...base, id, getSigningSecret: provider(secrets, CHANNEL_SECRETS.webhook.signing), ...(url ? { url } : {}) }));
    summary.push(`${id} (/hooks/${id}${url ? ", outbound" : ", inbound only"})`);
  }
  if (secrets.has(CHANNEL_SECRETS.github.webhook)) {
    const auth = optional(secrets, CHANNEL_SECRETS.github.token);
    channels.push(
      new GithubChannel({
        ...base,
        getWebhookSecret: provider(secrets, CHANNEL_SECRETS.github.webhook),
        ...(auth ? { getAuth: auth } : {}),
        ignoreLogins: csv(env["NG_GITHUB_IGNORE_LOGINS"]),
        ownerIds: csv(env["NG_GITHUB_OWNER_LOGINS"]),
        ...(env["NG_GITHUB_API_BASE"] ? { apiBase: env["NG_GITHUB_API_BASE"] } : {}),
      }),
    );
    summary.push(`github (/hooks/github${auth ? "" : ", no API token: replies fail"})`);
  }
  if (secrets.has(CHANNEL_SECRETS.slack.signing)) {
    const auth = optional(secrets, CHANNEL_SECRETS.slack.bot);
    channels.push(
      new SlackChannel({
        ...base,
        getSigningSecret: provider(secrets, CHANNEL_SECRETS.slack.signing),
        ...(auth ? { getAuth: auth } : {}),
        ...(env["NG_SLACK_BOT_USER_ID"] ? { botUserId: env["NG_SLACK_BOT_USER_ID"] } : {}),
        ...(env["NG_SLACK_BOT_ID"] ? { botId: env["NG_SLACK_BOT_ID"] } : {}),
        ownerIds: csv(env["NG_SLACK_OWNER_IDS"]),
      }),
    );
    summary.push(`slack (/hooks/slack${auth ? "" : ", no bot token: replies fail"})`);
  }
  if (secrets.has(CHANNEL_SECRETS.feishu.verification)) {
    const encrypt = optional(secrets, CHANNEL_SECRETS.feishu.encrypt);
    const auth = optional(secrets, CHANNEL_SECRETS.feishu.tenant);
    channels.push(
      new FeishuChannel({
        ...base,
        getVerificationToken: provider(secrets, CHANNEL_SECRETS.feishu.verification),
        ...(encrypt ? { getEncryptKey: encrypt } : {}),
        ...(auth ? { getAuth: auth } : {}),
        ...(env["NG_FEISHU_API_BASE"] ? { apiBase: env["NG_FEISHU_API_BASE"] } : {}),
        ownerIds: csv(env["NG_FEISHU_OWNER_IDS"]),
      }),
    );
    summary.push(`feishu (/hooks/feishu${auth ? "" : ", no tenant token: replies fail"})`);
  }
  return { channels, summary };
}
