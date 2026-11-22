import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, selectRunTools, type Envelope } from "@ng/protocol";
import { BUILTIN_SKILLS, PROMPTS, startProjectSync } from "../src";
import { RESTORE_REASON, resolveConfig } from "../src/shared/config";
import { promptDefs } from "../src/shared/prompts";
import { SKILL_DOMAIN_HUB, SKILL_HABIT_DISCOVERY, SKILL_PROJECT_RELAY, SKILL_WORKSPACE_ARBITRATION } from "../src/shared/skills";
import { boot, childrenOf, cleanupAll, lastToolResult, projects, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

/** What the app sends for "交回主台" (apps/gtd-desk restoreActivity). */
function restore(h: Harness, original: Envelope, activityId: string): void {
  h.kernel.inbox.enqueueSync("desk", {
    id: `${original.id}#restore#${activityId}`,
    from: "kernel:router",
    principalId: "owner",
    kind: "event",
    type: PAYLOAD.handback,
    payload: { original, fromCellId: "desk", reason: RESTORE_REASON },
    createdAt: h.clock.now(),
  });
}

describe("conventions the workbench app relies on", () => {
  it("an item moved back from the archive gets a card; archiving it again is refused", async () => {
    const h = await boot();
    h.script.add("desk", tool("archive_notification", { title: "CI 构建通过" }), tool("wait", { reason: "ok" }));
    const env = await h.memory.inject({ from: "ci-bot", text: "main 分支构建通过 #812" });
    await h.kernel.idle();
    const [archived] = h.activities();
    expect(archived).toMatchObject({ kind: "notification_archived", restorable: true, envelope: { id: env.id } });

    h.script.add(
      "desk",
      tool("archive_notification", { title: "CI 构建通过" }),
      (req) => {
        expect(lastToolResult(req)).toContain("moved this item back from the archive");
        return tool("present_to_owner", { title: "CI：main 分支构建通过 #812", summary: "构建通过，没有需要处理的；确认后归档。" });
      },
    );
    restore(h, archived!.envelope!, archived!.id);
    await h.kernel.idle();
    expect(h.activities()).toHaveLength(1);
    const [item] = h.kernel.humanItems.list();
    expect(item).toMatchObject({ cellId: "desk", title: "CI：main 分支构建通过 #812", subjectKey: `msg:${env.id}` });
    const decided = await h.kernel.humanItems.decide(item!.id, { optionId: "acknowledge", seenItemRevision: item!.itemRevision }, "owner");
    expect(decided.status).toBe("resolved");
  });

  it("weekly review reads a plan edited by the owner in its original and current versions", async () => {
    const h = await boot({ presets: { weeklyReview: "0 16 * * 5" } });
    h.script.add("desk", tool("propose_project", { title: "接口交付", outcome: "完成测试", actions: [{ title: "验证", owner: "agent" }] }));
    await h.ui.capture({ text: "安排接口交付" }, "owner");
    await h.kernel.idle();
    const card = h.cards()[0]!;
    const first = h.kernel.context.getArtifactSync(card.artifactId!)!;
    const revised = { ...first.content.data as Record<string, unknown>, outcome: "完成测试并录屏" };
    const saved = h.kernel.context.commitSync("desk", { artifact: { artifactId: first.artifactId, expectedVersion: 1,
      content: { format: "json", data: revised, body: JSON.stringify(revised) }, updatedBy: "human" } });
    expect(saved.ok).toBe(true);
    h.script.add("desk", tool("review_week"), {});
    h.clock.set(Date.UTC(2026, 10, 20, 8));
    await h.kernel.idle();
    const facts = lastToolResult(h.script.callsOf("desk").at(-1)!);
    expect(facts).toContain("方案初稿");
    expect(facts).toContain("主人修改后的方案");
    expect(facts).toContain("完成测试并录屏");
  });

  it("stopping a project the owner had paused closes it and everything below it; the records say cancelled", async () => {
    const h = await boot();
    h.script.add("desk", tool("start_project", { title: "整理客户名单", outcome: "一份去重后的客户名单", brief: "整理一下客户名单" }), tool("wait", { reason: "ok" }));
    h.script.add("project", tool("dispatch", { title: "整理名单", instruction: "整理客户名单" }), {});
    // Still at work: it waits for an answer (a bare wait would end its turn).
    h.script.add("worker", tool("wait", { reason: "thinking", waitingFor: "inbox:desk" }));
    await h.ui.capture({ text: "整理一下客户名单" }, "owner");
    await h.kernel.idle();
    const [project] = projects(h);
    const [worker] = childrenOf(h, project!);
    expect(h.kernel.control(project!, { action: "pause" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ applied: true });

    h.script.add("desk", tool("stop_item", { itemId: project, reason: "不需要了" }), tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "客户名单不用整理了" }, "owner");
    await h.kernel.idle();
    expect(h.project(project!)).toMatchObject({ lifecycle: "cancelled" });
    expect(h.actions(project)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(h.kernel.getCell(project!)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.kernel.getCell(worker!)).toMatchObject({ status: "closed", closeReason: "cancelled" });
  });
});

// ==================== prompts vs tools ====================

/**
 * Snake_case or `ticked` words that appear in the prompts but are not tools: argument values and shell commands (the
 * worker's look-only note names git subcommands: `git log` / `diff` / `show`; dispatch's `check`), a message type
 * (`cell.direct_chat`), the sample cell names of the project's board note, and the subject-matter terms COMMON gives
 * as examples of words that are never translated (`code_cell.rs`, `token`, `queue`, `epoch`).
 */
const NOT_TOOLS = new Set(["working_note", "research_then_park", "diff", "show", "check", "direct_chat", "worker_a1", "worker_b2", "code_cell", "token", "queue", "epoch", "restored_by_owner", "arbitration_unanswered", "stalled_check"]);

/**
 * Names a prompt mentions that its role does not have, reported to the prompts' owner (see the presets report). The
 * test fails when a new one appears — and when one listed here is fixed, so this list never goes stale.
 */
const KNOWN_PROMPT_GAPS: Readonly<Record<string, readonly string[]>> = {};

function mentionedTools(text: string): string[] {
  const prose = text.replace(/\bkind "[a-z_]+"/g, "");
  const snake = prose.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? [];
  const ticked = [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);
  return [...new Set([...snake, ...ticked])].filter((n) => !NOT_TOOLS.has(n) && !n.startsWith("cell_")).sort();
}

it("enforces scope at the run port even when a processor calls it directly", async () => {
  const results: PromiseSettledResult<void>[] = [];
  const h = await boot({ setup(registry) {
    registry.codeProcessors.register({
      name: "test.knowledge",
      async run({ ports }) {
        const upsert = ports.context.upsertSkillOrNote;
        const base = { name: "rule", body: "new", description: "", mode: "upsert" as const };
        results.push(...await Promise.allSettled([
          upsert(ports.self.cellId, { ...base, kind: "preference", scope: "cell" }),
          upsert(ports.self.cellId, { ...base, kind: "reference", scope: "global" }),
          upsert(ports.self.cellId, { ...base, kind: "working_note", scope: "cell" }),
        ]));
        return "completed";
      },
    });
  } });
  h.kernel.spawnCell("desk", { id: "child", preset: "worker", processor: { kind: "code", entry: "test.knowledge" } }, "整理笔记", { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  expect(results).toMatchObject([
    {status:"rejected", reason:{code:"bounds_violation"}},
    {status:"rejected", reason:{code:"bounds_violation"}},
    {status:"fulfilled"},
  ]);
  expect(h.kernel.context.getKnowledgeSync({kind:"working_note", scope:"cell", cellId:"child", name:"rule"})?.body).toBe("new");
  expect(h.kernel.context.getKnowledgeSync({kind:"reference", scope:"global", name:"rule"})).toBeNull();
});

it("protects preset records from model writes while leaving its own topic notes writable", async () => {
  const h = await boot();
  const keys = ["gtd:project", "gtd:activity:completed", "gtd:source", "gtd:action:task", "watch:state", "probe:state", "desk:suggestion:skill:x"];
  for (const key of keys) {
    h.script.add("desk", tool("set_state", { patches: { [key]: "forged" } }), req => {
      expect(lastToolResult(req)).toContain("reserved");
      return {};
    });
    await h.ui.capture({ text: key }, "owner");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync("desk", key)).toBeNull();
  }
  h.script.add("desk", tool("set_state", { patches: { "hub:topics": ["weekly"] } }), {});
  await h.ui.capture({ text: "设置主题" }, "owner");
  await h.kernel.idle();
  expect(h.kernel.context.readStateSync("desk", "hub:topics")).toEqual(["weekly"]);
});

describe("conventions: every prompt names only tools its role has", () => {
  it("role prompts and the playbooks they rely on", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    h.kernel.spawnCell(projectId, { preset: "worker", title: "w" }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.spawnCell(projectId, { preset: "checker", title: "c" }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.spawnCell("desk", { preset: "sensor", title: "s" }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.spawnCell("desk", { preset: "hub", title: "h" }, undefined, { principalId: h.kernel.ownerPrincipal });
    const cells = h.kernel.listCells({ status: ["active"] });
    const toolsOf = (prompt: string): string[] => {
      const cell = cells.find((c) => c.spec.processor.kind === "llm" && c.spec.processor.prompt === prompt);
      if (!cell || cell.spec.processor.kind !== "llm") throw new Error(`no cell runs ${prompt}`);
      return selectRunTools(h.registry.resolveTools(cell.spec.processor.toolsets ?? []), cell.spec.processor, cell.bounds, cell.spec).map((t) => t.name);
    };
    const skill = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name)!.body;
    const checks: Array<{ prompt: string; text: string; source: string }> = [
      ...promptDefs(resolveConfig()).map((p) => ({ prompt: p.name, text: p.text, source: p.name })),
      { prompt: PROMPTS.project, text: skill(SKILL_PROJECT_RELAY), source: SKILL_PROJECT_RELAY },
      { prompt: PROMPTS.hub, text: skill(SKILL_DOMAIN_HUB), source: SKILL_DOMAIN_HUB },
      { prompt: PROMPTS.desk, text: skill(SKILL_WORKSPACE_ARBITRATION), source: SKILL_WORKSPACE_ARBITRATION },
      { prompt: PROMPTS.desk, text: skill(SKILL_HABIT_DISCOVERY), source: SKILL_HABIT_DISCOVERY },
    ];
    const missing: Record<string, string[]> = {};
    for (const c of checks) {
      const have = new Set(toolsOf(c.prompt));
      const gaps = mentionedTools(c.text).filter((n) => !have.has(n));
      if (gaps.length) missing[c.source] = [...(missing[c.source] ?? []), ...gaps];
    }
    expect(missing).toEqual(KNOWN_PROMPT_GAPS);
    // A worker and the checker preset's checker are leaves (maxDepth 0): the tools that start, steer or close cells are
    // not offered to them, so no prompt or playbook of theirs may rely on them. They keep the shell and the files, and
    // update_cell for their own watches.
    for (const prompt of [PROMPTS.worker, PROMPTS.checker]) {
      expect(toolsOf(prompt)).toEqual(expect.arrayContaining(["job_start", "update_cell"]));
      for (const name of ["spawn_cell", "control_cell", "close_cell"]) expect(toolsOf(prompt)).not.toContain(name);
    }
    // The coordinators read what their cells did.
    for (const prompt of [PROMPTS.desk, PROMPTS.project, PROMPTS.hub]) expect(toolsOf(prompt)).toContain("inspect_cell");
    // Every registered role prompt was checked.
    expect(new Set(checks.map((c) => c.prompt))).toEqual(new Set(Object.values(PROMPTS)));
    // Non-modifying roles must not receive the worker's "creating a branch, committing..." permission line, and all roles know the owner's timezone.
    const defs = Object.fromEntries(promptDefs(resolveConfig({ timeZone: "Asia/Shanghai" })).map((p) => [p.name, p.text]));
    for (const name of [PROMPTS.desk, PROMPTS.project, PROMPTS.hub, PROMPTS.checker, PROMPTS.sensor]) {
      expect(defs[name]).not.toContain("creating a branch, committing on your branch");
      expect(defs[name]).toContain("Asia/Shanghai");
    }
    expect(defs[PROMPTS.worker]).toContain("Asia/Shanghai");
  });

  it("includes deterministic seeded actionIds in the project brief and open human actions in project wake-up tail notes", async () => {
    const h = await boot();
    let firstPrompt = "";
    let secondPrompt = "";
    h.script.add(
      "project",
      (req) => {
        firstPrompt = JSON.stringify(req.messages);
        return {};
      },
      (req) => {
        secondPrompt = JSON.stringify(req.messages);
        return {};
      },
    );
    const { projectId } = startProjectSync(h.kernel, {
      id: "proj_brief_ids",
      title: "接口整理",
      outcome: "完成整理并验收",
      brief: "整理接口并请主人验收",
      plan: [
        { title: "拉取接口清单", owner: "agent" },
        { title: "确认对外字段", owner: "human", nextStep: "核对字段列表" },
      ],
    }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    const acts = h.actions(projectId);
    expect(acts).toHaveLength(2);
    for (const a of acts) expect(firstPrompt).toContain(a.id);

    h.kernel.sendToCell(projectId, { text: "继续看下进度" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    const human = acts.find((a) => a.owner === "human")!;
    expect(secondPrompt).toContain("[your open actions]");
    expect(secondPrompt).toContain(human.id);
    expect(secondPrompt).toContain("确认对外字段");
    expect(secondPrompt).toContain("核对字段列表");
  });

  it("propose_project reuses subjectKey on approval.revise instead of creating a duplicate card", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("propose_project", { title: "初版方案", outcome: "完成 A", actions: [{ title: "做 A", owner: "agent" }] }),
    );
    await h.ui.capture({ text: "规划一下 A" }, "owner");
    await h.kernel.idle();
    const [initial] = h.kernel.humanItems.list();
    expect(initial).toBeDefined();

    let revisePrompt = "";
    h.script.add("desk", (req) => {
      revisePrompt = JSON.stringify(req.messages);
      return tool("propose_project", {
        title: "修订方案",
        outcome: "完成 A 和 B",
        actions: [{ title: "做 A 和 B", owner: "agent" }],
        subjectKey: initial!.subjectKey,
      });
    });
    const reviseOpt = initial!.options.find((o) => o.effect === "revise")!;
    await h.kernel.humanItems.decide(
      initial!.id,
      { optionId: reviseOpt.id, seenItemRevision: initial!.itemRevision, seenArtifactVersion: initial!.artifactVersion ?? undefined, note: "加上 B" },
      "owner",
    );
    await h.kernel.idle();
    expect(revisePrompt).toContain("The owner asked for a revision to the pending card below");
    const open = h.kernel.humanItems.list();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "修订方案", subjectKey: initial!.subjectKey });
  });
});
