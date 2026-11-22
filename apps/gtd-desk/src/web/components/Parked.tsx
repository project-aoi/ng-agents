import { useState } from "react";
import { relativeTimeZh, type ButtonDTO, type ArtifactDTO } from "../../shared/api";
import { request } from "../api";
import { toFailure, useNow, useToast } from "../state";
import type { DraftApi } from "./draft";
import { Spinner } from "./controls";
export function Parked(props: { draft: DraftApi; structured?: boolean }) {
  const parked = (props.draft.conflict ?? props.draft.base).parked;
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  if (parked.length === 0) return null;
  const dismiss = async (id: string, b: ButtonDTO) => {
    if (!b.endpoint) return;
    setBusy(id);
    try {
      const a = await request<ArtifactDTO>(b.endpoint.method, b.endpoint.path, b.endpoint.body ?? {});
      props.draft.accept(a);
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="side-block parked">
      <h3 className="side-title">
        后台补充的新信息 <span className="count">{parked.length}</span>
      </h3>
      <p className="side-note">你修改草稿后，后台又收到了这些内容。它们没有覆盖你的草稿，合并完可以移除。</p>
      {parked.map((p) => (
        <article key={p.id} className="parked-item">
          <div className="parked-meta">
            {p.title && <strong>{p.title}</strong>}
            <span className="muted">
              {relativeTimeZh(p.createdAt, now)}
              {p.basedOnVersion > 0 ? ` · 基于 v${p.basedOnVersion}` : ""}
            </span>
          </div>
          {p.note && <p className="parked-note">{p.note}</p>}
          <pre className="parked-body">{p.body}</pre>
          <div className="parked-actions">
            {!props.structured && <button
              type="button"
              className="btn sm ghost"
              onClick={() => props.draft.setText(`${props.draft.text.replace(/\s*$/, "")}\n\n${p.body}\n`)}
              disabled={props.draft.conflict !== null}
            >
              追加到草稿末尾
            </button>}
            <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void dismiss(p.id, p.dismiss)}>
              {busy === p.id && <Spinner />}
              {p.dismiss.label}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
