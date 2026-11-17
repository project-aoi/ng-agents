import { isHttpChannel } from "@ng/channel";
import type { SourceRecord } from "@ng/protocol";
import type { ChannelSourceDTO, SensorSourceDTO, SourcesDTO } from "../../shared/api";
import { readSources, type ProjectionInput } from "./common";
import { button, channelLabel, enc, post } from "./format";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "每周一 09:00" / "每天 09:00" / "每 30 分钟" for the common shapes, else the raw expression. */
export function cronText(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length === 5) {
    const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
    const every = /^\*\/(\d+)$/.exec(min);
    if (every && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `每 ${every[1]} 分钟`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
      const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
      if (dow === "*") return `每天 ${at}`;
      if (/^[0-6]$/.test(dow)) return `每${WEEKDAYS[Number(dow)]} ${at}`;
      if (dow === "1-5") return `工作日 ${at}`;
    }
    if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return "每小时";
  }
  return `cron ${cron}`;
}

export function scheduleText(s: SourceRecord["schedule"]): string {
  if (s?.cron) return cronText(s.cron) + (s.tz ? `（${s.tz}）` : "");
  if (s?.idleSec) return `空闲 ${Math.round(s.idleSec / 60)} 分钟后检查`;
  return "收到消息时";
}

const STATE_LABEL = { ready: "正常", stopped: "已停止", error: "出错" } as const;
const STATUS_LABEL = { ok: "运行正常", error: "出错", paused: "已暂停" } as const;
const MODE_LABEL = { active: "命中时投进信箱", observe: "只记观察笔记，不弹卡" } as const;
const PROCESSOR_LABEL = { code: "脚本检查（零 Token）", llm: "模型初筛" } as const;

export function projectSources(input: ProjectionInput): SourcesDTO {
  const { kernel, now } = input;
  const channels: ChannelSourceDTO[] = kernel.hub.listInfoSync().map((c) => ({
    id: c.id,
    label: channelLabel(c.id),
    kind: c.kind,
    state: c.status.state,
    stateLabel: STATE_LABEL[c.status.state] ?? c.status.state,
    lastIngressAt: c.status.lastIngressAt,
    lastDeliveryAt: c.status.lastDeliveryAt,
    lastError: c.status.lastError,
    hookPath: (() => {
      const ch = kernel.hub.get(c.id);
      return ch && isHttpChannel(ch) ? `/hooks/${enc(c.id)}` : null;
    })(),
  }));

  const sensors: SensorSourceDTO[] = [];
  for (const s of readSources(kernel)) {
    const cell = kernel.getCell(s.cellId);
    if (!cell || cell.status === "closed") continue;
    const r = s.record;
    const status = cell.status === "paused" ? "paused" : r.status === "paused" ? "ok" : r.status;
    const base = `/api/sources/${enc(s.cellId)}`;
    const other = r.mode === "observe" ? "active" : "observe";
    sensors.push({
      id: s.cellId,
      title: r.title,
      description: r.description ?? null,
      kind: r.kind,
      scheduleText: scheduleText(r.schedule),
      mode: r.mode,
      modeLabel: MODE_LABEL[r.mode],
      status,
      statusLabel: STATUS_LABEL[status],
      processor: r.processor,
      processorLabel: PROCESSOR_LABEL[r.processor],
      lastRunAt: r.lastRunAt ?? null,
      lastHitAt: r.lastHitAt ?? null,
      lastError: r.lastError ?? null,
      runCount: r.runCount,
      hitCount: r.hitCount,
      buttons: [
        status === "paused"
          ? button({ id: "resume", label: "▶ 恢复", primary: true, endpoint: post(`${base}/resume`) })
          : button({ id: "pause", label: "⏸ 暂停", endpoint: post(`${base}/pause`) }),
        button({
          id: "mode",
          label: other === "observe" ? "改为只记观察笔记" : "改为命中时投进信箱",
          endpoint: { method: "PUT", path: `${base}/mode`, body: { mode: other } },
        }),
        button({ id: "delete", label: "删除信源", group: "more", endpoint: { method: "DELETE", path: base }, confirm: `删除信源「${r.title}」？` }),
      ],
    });
  }
  sensors.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  return { generatedAt: now, channels, sensors };
}
