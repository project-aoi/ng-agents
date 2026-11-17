import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  BALL_LABEL,
  EFFORT_LABELS,
  type ApproveResponse,
  type ArtifactDTO,
  type BallOwner,
  type ButtonDTO,
  type ClarifyCardDTO,
  type ClarifyMutationResponse,
  type ClarifyQueueDTO,
  type Effort,
  type ProposalDTO,
} from "../../shared/api";
import { api, callButton, request } from "../api";
import { References, SourceText, WaitingParties } from "../components/bits";
import { BallChip, ButtonRow, Spinner, type ButtonRowHandle } from "../components/controls";
import { DraftEditor, forgetUnsaved, useDraft } from "../components/draft";
import { ErrorState, Loading } from "../components/states";
import { isActivatableTarget, syncServerClock, toFailure, useNavigate, useNow, useResource, useStatus, useToast, useViewKeys, type Tone } from "../state";
import { prettyTarget, rawKindLabel } from "../text";

type Notice = { tone: Tone; text: string };

interface CardHandle {
  primary(): boolean;
  edit(): boolean;
  snooze(): boolean;
  revise(): boolean;
  save(): boolean;
}

type ClarifyResult = ClarifyMutationResponse | ApproveResponse;

export function ClarifyView({ cardId }: { cardId?: string | undefined }) {
  const res = useResource<ClarifyQueueDTO>("clarify", api.clarify, ["clarify"]);
  const { setStatus } = useStatus();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow();
  const [currentId, setCurrentId] = useState<string | null>(cardId ?? null);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const lastIdx = useRef(0);
  const cardRef = useRef<CardHandle>(null);

  useEffect(() => {
    if (cardId) setCurrentId(cardId);
  }, [cardId]);
  useEffect(() => {
    if (res.data) syncServerClock(res.data.generatedAt);
  }, [res.data]);

  const cards = res.data?.cards ?? [];
  let idx = cards.findIndex((c) => c.id === currentId);
  if (idx < 0) idx = Math.max(0, Math.min(lastIdx.current, cards.length - 1));
  const card = cards[idx];

  // A new card starts at its top (source bar first), not wherever the previous one was scrolled to.
  useEffect(() => {
    document.querySelector(".stage")?.scrollTo({ top: 0 });
  }, [card?.id]);

  const next = () => {
    if (cards.length < 2) return;
    const n = cards[(idx + 1) % cards.length];
    if (n) setCurrentId(n.id);
  };

  useViewKeys((e) => {
    const h = cardRef.current;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return h?.save() ?? false;
    if (!h) return false;
    switch (e.key) {
      case "Enter":
        return isActivatableTarget(e.target) ? false : h.primary();
      case "n":
      case "N":
      case "ArrowRight":
        next();
        return true;
      case "e":
      case "E":
        return h.edit();
      case "s":
      case "S":
        return h.snooze();
      case "r":
      case "R":
        return h.revise();
      default:
        return false;
    }
  });

  const setNotice = (id: string, n: Notice | null) =>
    setNotices((all) => {
      const copy = { ...all };
      if (n) copy[id] = n;
      else delete copy[id];
      return copy;
    });

  const apply = (forCard: ClarifyCardDTO, r: ClarifyResult) => {
    res.set(r.view);
    setStatus(r.status);
    syncServerClock(r.view.generatedAt);
    if (!r.view.cards.some((c) => c.id === forCard.id)) forgetUnsaved(forCard.draft?.artifactId);
    const detail = "error" in r && r.error ? `（${r.error}）` : "";
    switch (r.outcome) {
      case "sent":
      case "approved":
        setNotice(forCard.id, null);
        toast({ tone: "success", text: r.message });
        return;
      case "version_mismatch":
        setCurrentId(forCard.id);
        setNotice(forCard.id, { tone: "warn", text: "草稿已更新，请重看：下面是最新版本，确认前再看一遍。" });
        return;
      case "unknown":
        setCurrentId(forCard.id);
        setNotice(forCard.id, { tone: "warn", text: `${r.message}${detail}：请到对方那边确认是否收到，再在下面标记结果。系统不会自动重发。` });
        return;
      case "failed":
        setCurrentId(forCard.id);
        setNotice(forCard.id, { tone: "error", text: `${r.message}${detail}` });
        return;
      case "already_cancelled":
      case "not_found":
      case "not_pending":
        setNotice(forCard.id, null);
        toast({ tone: "info", text: r.message });
        return;
      case "to_human": {
        const item = (r as ClarifyMutationResponse).engageItem;
        toast({
          tone: "success",
          text: r.message,
          ...(item ? { action: { label: "去处理", run: () => navigate({ view: "engage", item }) } } : {}),
        });
        return;
      }
      case "someday":
        toast({ tone: "success", text: r.message, action: { label: "在项目全局查看", run: () => navigate({ view: "radar" }) } });
        return;
      default:
        setNotice(forCard.id, null);
        toast({ tone: r.ok ? "success" : "warn", text: r.message });
    }
  };

  const mutate = async (forCard: ClarifyCardDTO, b: ButtonDTO, extra: Record<string, unknown> = {}) => {
    try {
      const r = await callButton<ClarifyResult>(b, extra);
      apply(forCard, r);
    } catch (err) {
      const f = toFailure(err);
      toast({ tone: "error", text: f.message });
      // 409 = the card moved on (handled elsewhere, withdrawn…): show the queue as it is now.
      if (f.status === 409 || f.status === 404) res.reload();
    }
  };

  if (!res.data) {
    return (
      <div className="stage-narrow">{res.error && !res.loading ? <ErrorState error={res.error} onRetry={res.reload} title="待确认没能载入" /> : <Loading label="正在载入待确认…" />}</div>
    );
  }
  lastIdx.current = idx;
  const q = res.data;
  if (!card) return <InboxZero q={q} />;

  return (
    <div className="stage-narrow clarify">
      <div className="clarify-meta">
        <span className="remaining" aria-live="polite">
          剩余 <strong>{q.remaining}</strong> 张
        </span>
        {q.snoozed > 0 && <span className="muted">· 已推迟 {q.snoozed} 张</span>}
        {cards.length > 1 && (
          <span className="muted position" aria-hidden="true">
            {idx + 1} / {cards.length}
          </span>
        )}
      </div>
      <ClarifyCard
        key={card.id}
        card={card}
        now={now}
        notice={notices[card.id] ?? null}
        canSkip={cards.length > 1}
        onNext={next}
        onMutate={(b, extra) => mutate(card, b, extra)}
        onApplied={(r) => apply(card, r)}
        handleRef={cardRef}
      />
      {res.error && <p className="stale-note">刷新失败：{res.error.message}（显示的是上次载入的内容）</p>}
    </div>
  );
}

// ==================== Inbox Zero ====================

function InboxZero({ q }: { q: ClarifyQueueDTO }) {
  const navigate = useNavigate();
  return (
    <div className="stage-narrow">
      <section className="inbox-zero" aria-live="polite">
        <div className="zero-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
            <path d="M15 24.5l6.5 6.5L33 18.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2>收件箱已清空（Inbox Zero）</h2>
        <p className="muted">没有需要你拍板的事了。新的事项准备好初稿后会出现在这里。</p>
        <dl className="zero-facts">
          <div>
            <dt>后台</dt>
            <dd>{q.background.text}</dd>
          </div>
          {q.background.jobs > 0 && (
            <div>
              <dt>长任务</dt>
              <dd>{q.background.jobs} 个在运行</dd>
            </div>
          )}
          {q.snoozed > 0 && (
            <div>
              <dt>已推迟</dt>
              <dd>{q.snoozed} 张卡，到点会回到这里</dd>
            </div>
          )}
        </dl>
        <div className="zero-actions">
          <button type="button" className="btn" onClick={() => navigate({ view: "engage" })}>
            去专注工作区挑一件事
          </button>
          <button type="button" className="btn ghost" onClick={() => navigate({ view: "radar" })}>
            看看项目全局
          </button>
        </div>
      </section>
    </div>
  );
}

// ==================== one card ====================

const CONFIRM_IDS = new Set(["confirm", "retry_send"]);

function ClarifyCard(props: {
  card: ClarifyCardDTO;
  now: number;
  notice: Notice | null;
  canSkip: boolean;
  onNext(): void;
  onMutate(b: ButtonDTO, extra?: Record<string, unknown>): Promise<void>;
  onApplied(r: ClarifyMutationResponse): void;
  handleRef: Ref<CardHandle>;
}) {
  const { card, now } = props;
  const toast = useToast();
  const isPlan = card.cardType === "project_proposal";
  const draft = useDraft(card.draft && !isPlan ? card.draft : null);
  const [planOpen, setPlanOpen] = useState(false);
  const rowRef = useRef<ButtonRowHandle>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const editable = draft !== null && card.state === "pending";
  const planButton = card.buttons.find((b) => b.client === "open_plan_editor");

  useImperativeHandle(props.handleRef, () => ({
    primary: () => rowRef.current?.triggerPrimary() ?? false,
    edit: () => {
      if (isPlan && planButton) {
        setPlanOpen(true);
        return true;
      }
      if (editable && taRef.current) {
        taRef.current.focus();
        taRef.current.scrollIntoView({ block: "center" });
        return true;
      }
      return false;
    },
    snooze: () => {
      const r = rowRef.current;
      if (!r) return false;
      if (r.has("snooze")) return r.trigger("snooze");
      const extend = card.buttons.find((b) => b.id === "extend" && !b.primary);
      return extend ? r.trigger("extend") : false;
    },
    revise: () => rowRef.current?.trigger("revise_voice") ?? false,
    save: () => {
      if (!draft?.dirty) return false;
      void draft.save();
      return true;
    },
  }));

  const run = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    if (b.client === "skip") {
      props.onNext();
      return;
    }
    if (b.client === "open_plan_editor") {
      setPlanOpen(true);
      return;
    }
    const extra: Record<string, unknown> = { ...input };
    // Typed in a text field, not a voice transcript (press-and-hold dictation is not built into the web client).
    if (b.input?.kind === "instruction") extra["voice"] = false;
    if (draft && CONFIRM_IDS.has(b.id)) {
      if (draft.conflict) {
        toast({ tone: "warn", text: "草稿有更新的版本：先对照合并，再确认" });
        return;
      }
      // What goes out is exactly what the owner sees: unsaved edits are saved first and that version is confirmed.
      const seen = draft.dirty ? await draft.save() : draft.base;
      if (!seen) return;
      extra["seenVersion"] = seen.version;
    }
    await props.onMutate(b, extra);
  };

  const confirmLabel = (() => {
    const c = card.buttons.find((b) => b.id === "confirm");
    return draft?.dirty && c ? `保存并${c.label.replace(/^✓\s*/, "")}` : null;
  })();
  const buttons = confirmLabel ? card.buttons.map((b) => (b.id === "confirm" ? { ...b, label: `✓ ${confirmLabel}` } : b)) : card.buttons;

  const statusTone = card.state === "send_unknown" ? "warn" : card.state === "send_failed" ? "error" : card.sourceBar.draftUpdated ? "warn" : card.state === "revising" ? "busy" : "";

  return (
    <article className={`card card-${card.cardType} state-${card.state}`} aria-labelledby={`card-${card.id}-title`}>
      {/* block 1: source & state */}
      <header className="card-bar">
        <SourceText source={card.sourceBar.source} now={now} />
        <span className={`status-pill ${statusTone}`}>
          {card.state === "revising" && <Spinner />}
          {card.sourceBar.statusText}
        </span>
      </header>
      <h2 className="card-title" id={`card-${card.id}-title`}>
        {card.title}
      </h2>

      {props.notice && (
        <div className={`banner ${props.notice.tone}`} role="alert">
          {props.notice.text}
        </div>
      )}
      {card.outcome && !props.notice && (
        <div className={`banner ${card.outcome.state === "send_unknown" ? "warn" : "error"}`} role="alert">
          <p>
            <strong>{card.outcome.message}</strong>
            {card.outcome.error && <span className="muted">（{card.outcome.error}）</span>}
            {card.outcome.state === "send_unknown" ? " 请到对方那边确认是否收到，再在下面标记结果。系统不会自动重发。" : " 可以重新发送，或者不发了。"}
          </p>
        </div>
      )}

      {/* block 2: raw input */}
      <section className="block raw" aria-label={rawKindLabel(card.rawInput.kind)}>
        <h3 className="block-label">{rawKindLabel(card.rawInput.kind)}</h3>
        <div className="raw-text">{card.rawInput.text}</div>
      </section>

      {/* block 3: preparation and the draft / plan / blocker */}
      <section className="block prep" aria-label="Agent 的准备">
        {(card.prep.summary || card.prep.checked.length > 0) && (
          <>
            <h3 className="block-label">Agent 已经查过</h3>
            {card.prep.summary && <p className="prep-summary">{card.prep.summary}</p>}
            <References items={card.prep.checked} />
          </>
        )}

        {card.escalation && (
          <div className="escalation">
            <p>
              <span className="badge danger-soft">{card.escalation.reasonLabel}</span> {card.escalation.explanation}
            </p>
            {card.escalation.waiting && <WaitingParties waiting={card.escalation.waiting} now={now} />}
            {card.escalation.usage && <p className="usage muted">{card.escalation.usage.text}</p>}
          </div>
        )}

        {isPlan && card.proposal && !planOpen && <PlanView proposal={card.proposal} versionText={card.draft?.versionText ?? null} />}
        {isPlan && card.proposal && planOpen && planButton && (
          <PlanEditor
            card={card}
            button={planButton}
            onClose={() => setPlanOpen(false)}
            onSaved={(r) => {
              setPlanOpen(false);
              props.onApplied(r);
            }}
            onConflictView={(r) => props.onApplied({ ...r, outcome: "conflict", message: r.message })}
          />
        )}

        {draft && (
          <DraftEditor
            draft={draft}
            textareaRef={taRef}
            readOnly={!editable}
            readOnlyNote={
              card.state === "revising"
                ? "正在按你的意见重拟，新版本到了会自动刷新"
                : card.state === "send_unknown"
                  ? "这是你确认发出的版本"
                  : card.state === "send_failed"
                    ? "这是上次尝试发送的版本"
                    : undefined
            }
            label={<DraftLabel card={card} />}
            minRows={2}
          />
        )}
      </section>

      {/* block 4: buttons */}
      <footer className="card-actions">
        <ButtonRow
          buttons={buttons}
          onRun={run}
          handleRef={rowRef}
          hints
          hide={!props.canSkip ? ["skip"] : undefined}
          inputNote={{ instruction: "语音口述还没有接入网页端，先用文字写下修改意见。" }}
        />
      </footer>
    </article>
  );
}

function DraftLabel({ card }: { card: ClarifyCardDTO }) {
  const r = card.reply;
  const kind = card.cardType === "escalation" ? "催问草稿" : r?.confirmVerb === "merge" ? "合入说明" : r?.confirmVerb === "accept" ? "结果" : "回复草稿";
  if (!r || r.confirmVerb === "accept") return <span className="draft-kind">{kind}</span>;
  return (
    <span className="draft-kind">
      {kind} · {r.confirmVerb === "merge" ? "" : "发给 "}
      {prettyTarget(r.targetLabel)}
      <span className="muted">（{r.channelLabel}）</span>
    </span>
  );
}

// ==================== project proposal ====================

function PlanView({ proposal, versionText }: { proposal: ProposalDTO; versionText: string | null }) {
  return (
    <div className="plan">
      <div className="plan-head">
        <h3 className="block-label">建议立项</h3>
        {versionText && <span className="draft-version">{versionText}</span>}
      </div>
      <dl className="plan-facts">
        <div>
          <dt>项目</dt>
          <dd>{proposal.title}</dd>
        </div>
        <div>
          <dt>完成的样子</dt>
          <dd>{proposal.outcome}</dd>
        </div>
        {proposal.background && (
          <div>
            <dt>背景</dt>
            <dd>{proposal.background}</dd>
          </div>
        )}
      </dl>
      <h4 className="plan-sub">推进安排</h4>
      {proposal.actions.length === 0 ? (
        <p className="muted">还没有具体动作。</p>
      ) : (
        <ol className="plan-actions">
          {proposal.actions.map((a, i) => (
            <li key={i}>
              <BallChip owner={a.owner} label={a.ownerLabel} />
              <div className="plan-action-body">
                <span className="plan-action-title">{a.title}</span>
                {(a.nextStep || a.effortLabel) && (
                  <span className="muted">
                    {a.nextStep}
                    {a.nextStep && a.effortLabel ? " · " : ""}
                    {a.effortLabel}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

interface PlanForm {
  title: string;
  outcome: string;
  background: string;
  actions: Array<{ title: string; owner: BallOwner; effort: Effort | ""; nextStep: string }>;
}

function formOf(p: ProposalDTO): PlanForm {
  return {
    title: p.title,
    outcome: p.outcome,
    background: p.background ?? "",
    actions: p.actions.map((a) => ({ title: a.title, owner: a.owner, effort: a.effort ?? "", nextStep: a.nextStep ?? "" })),
  };
}

const OWNERS: BallOwner[] = ["human", "agent", "waiting"];
const EFFORTS: Effort[] = ["15m", "45m", "low_energy"];

/** "✎ 手动改一下安排": edits the plan in place; saved with the version it was opened on (409 keeps the form). */
function PlanEditor(props: {
  card: ClarifyCardDTO;
  button: ButtonDTO;
  onClose(): void;
  onSaved(r: ClarifyMutationResponse): void;
  onConflictView(r: ClarifyMutationResponse): void;
}) {
  const { card, button } = props;
  const toast = useToast();
  const opened = (button.endpoint?.body?.["expectedVersion"] as number | null | undefined) ?? card.sourceBar.version;
  const [form, setForm] = useState<PlanForm>(() => formOf(card.proposal!));
  const [expected, setExpected] = useState<number | null>(opened ?? null);
  const [conflict, setConflict] = useState<ArtifactDTO | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const moved = card.sourceBar.version !== null && expected !== null && card.sourceBar.version > expected && !conflict;

  const save = async (version: number | null) => {
    if (!button.endpoint) return;
    if (version === null) {
      setError("这张卡的方案没有可保存的版本");
      return;
    }
    const actions = form.actions.filter((a) => a.title.trim());
    if (!form.outcome.trim()) {
      setError("请写下完成的样子");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await request<ClarifyMutationResponse>(button.endpoint.method, button.endpoint.path, {
        expectedVersion: version,
        proposal: {
          title: form.title.trim() || undefined,
          outcome: form.outcome.trim(),
          ...(form.background.trim() ? { background: form.background.trim() } : {}),
          actions: actions.map((a) => ({
            title: a.title.trim(),
            owner: a.owner,
            ...(a.effort ? { effort: a.effort } : {}),
            ...(a.nextStep.trim() ? { nextStep: a.nextStep.trim() } : {}),
          })),
        },
      });
      if (r.outcome === "conflict") {
        setConflict(r.current ?? null);
        props.onConflictView(r);
        return;
      }
      if (!r.ok) {
        setError(r.message);
        return;
      }
      props.onSaved(r);
    } catch (err) {
      const f = toFailure(err);
      setError(f.message);
      toast({ tone: "error", text: f.message });
    } finally {
      setSaving(false);
    }
  };

  const setAction = (i: number, patch: Partial<PlanForm["actions"][number]>) =>
    setForm((f) => ({ ...f, actions: f.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));

  return (
    <form
      className="plan-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save(expected);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="plan-head">
        <h3 className="block-label">手动改一下安排</h3>
        {expected !== null && <span className="draft-version">基于 v{expected}</span>}
      </div>

      {moved && (
        <div className="banner warn" role="status">
          方案已在后台更新到 v{card.sourceBar.version}。你的修改还在下面；保存时会提示你合并。
        </div>
      )}
      {conflict && (
        <div className="banner conflict" role="alert">
          <div>
            <strong>方案在你编辑时已更新到 v{conflict.version}（{conflict.updatedByLabel}）。</strong>
            <span>你的修改还在下面，没有丢，也还没保存。对照最新方案后决定：</span>
          </div>
          {card.proposal && (
            <details className="theirs-plan">
              <summary>看 v{conflict.version} 的方案</summary>
              <PlanView proposal={card.proposal} versionText={null} />
            </details>
          )}
          <div className="banner-actions">
            <button type="button" className="btn sm ghost" onClick={props.onClose}>
              放弃我的修改
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={saving}
              onClick={() => {
                setExpected(conflict.version);
                setConflict(null);
                void save(conflict.version);
              }}
            >
              按我的修改保存为 v{conflict.version + 1}
            </button>
          </div>
        </div>
      )}

      <label className="field">
        <span>项目名称</span>
        <input ref={firstRef} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <label className="field">
        <span>完成的样子</span>
        <textarea rows={2} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} />
      </label>
      <label className="field">
        <span>背景（可选）</span>
        <textarea rows={2} value={form.background} onChange={(e) => setForm({ ...form, background: e.target.value })} />
      </label>

      <fieldset className="plan-edit-actions">
        <legend>推进安排</legend>
        {form.actions.map((a, i) => (
          <div className="plan-edit-row" key={i}>
            <input aria-label={`动作 ${i + 1}`} placeholder="要做的事" value={a.title} onChange={(e) => setAction(i, { title: e.target.value })} />
            <select aria-label={`动作 ${i + 1} 由谁推进`} value={a.owner} onChange={(e) => setAction(i, { owner: e.target.value as BallOwner })}>
              {OWNERS.map((o) => (
                <option key={o} value={o}>
                  {BALL_LABEL[o]}
                </option>
              ))}
            </select>
            <select aria-label={`动作 ${i + 1} 需要的时间`} value={a.effort} onChange={(e) => setAction(i, { effort: e.target.value as Effort | "" })}>
              <option value="">不限时间</option>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {EFFORT_LABELS[x]}
                </option>
              ))}
            </select>
            <input
              className="wide"
              aria-label={`动作 ${i + 1} 的下一步`}
              placeholder="具体下一步（可选）"
              value={a.nextStep}
              onChange={(e) => setAction(i, { nextStep: e.target.value })}
            />
            <button type="button" className="btn sm ghost" aria-label={`删掉动作 ${i + 1}`} onClick={() => setForm((f) => ({ ...f, actions: f.actions.filter((_, j) => j !== i) }))}>
              删掉
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setForm((f) => ({ ...f, actions: [...f.actions, { title: "", owner: "human", effort: "", nextStep: "" }] }))}
        >
          ＋ 加一个动作
        </button>
      </fieldset>

      {error && (
        <p className="draft-message error" role="alert">
          {error}
        </p>
      )}
      <div className="plan-editor-foot">
        <button type="button" className="btn" onClick={props.onClose}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={saving || conflict !== null}>
          {saving && <Spinner />}
          保存方案
        </button>
      </div>
    </form>
  );
}
