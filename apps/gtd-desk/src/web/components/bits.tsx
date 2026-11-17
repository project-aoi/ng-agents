import type { ReferenceDTO, SourceInfoDTO, WaitingDTO } from "../../shared/api";
import { relativeTimeZh } from "../../shared/api";
import { dueText } from "../text";

/** Links the owner can open; internal references (no web address) are shown as plain labels. */
export function References({ items, title }: { items: readonly ReferenceDTO[]; title?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="refs">
      {title && <h4 className="refs-title">{title}</h4>}
      <ul>
        {items.map((r) => {
          const web = /^https?:\/\//i.test(r.uri);
          return (
            <li key={`${r.uri}-${r.label}`}>
              {web ? (
                <a href={r.uri} target="_blank" rel="noreferrer noopener">
                  {r.label}
                </a>
              ) : (
                <span className="ref-label">{r.label}</span>
              )}
              {r.detail && <span className="ref-detail">{r.detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SourceText({ source, now }: { source: SourceInfoDTO; now: number }) {
  const when = source.at > 0 ? relativeTimeZh(source.at, now) : null;
  const label = source.uri && /^https?:\/\//i.test(source.uri) ? (
    <a href={source.uri} target="_blank" rel="noreferrer noopener">
      {source.label}
    </a>
  ) : (
    source.label
  );
  return (
    <span className="source-text">
      {label}
      {when && <> · {when}</>}
    </span>
  );
}

/** Who has answered and who is still due: "已回 2/3 · 剩 供应商 C 明天到期" with the parties spelled out. */
export function WaitingParties({ waiting, now }: { waiting: WaitingDTO; now: number }) {
  return (
    <div className="waiting">
      <p className="waiting-text">
        {waiting.description && <span>{waiting.description} · </span>}
        {waiting.text}
      </p>
      {waiting.parties.length > 0 && (
        <ul className="parties">
          {waiting.parties.map((p) => {
            const due = p.dueAt ?? waiting.dueAt;
            return (
              <li key={p.label} className={p.replied ? "replied" : due !== null && due < now ? "overdue" : "open"}>
                <span className="party-mark" aria-hidden="true">
                  {p.replied ? "✓" : "…"}
                </span>
                <span className="party-label">{p.label}</span>
                <span className="party-state">{p.replied ? (p.repliedAt ? `${relativeTimeZh(p.repliedAt, now)}回复` : "已回复") : due !== null ? dueText(due, now) : "未回复"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
