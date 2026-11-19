import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, type ActionRecord } from "@ng/protocol";
import { notifyProjectOfOwnerChangeSync } from "../src";
import { boot, cleanupAll, gitRepo, lastToolResult, projects, requestText, tempDir, tool } from "./helpers";

afterEach(cleanupAll);

const artifactIdIn = (text: string) => /Saved (\S+) v\d+/.exec(text)?.[1] ?? "";

describe("docs/05 scenario 1 — part of the work waits for the owner; the report grows version by version", () => {
  it("a human action + wait; the owner ticks it off in the app; a second worker extends the same report with expectedVersion", async () => {
    const h = await boot();
    const trae = gitRepo("trae");
    const doubao = join(tempDir("code"), "doubao-work"); // not on this machine yet

    h.script.add(
      "desk",
      tool("start_project", {
        title: "Harness 对比分析",
        outcome: "一份 traecli / trae ide / Doubao work 三方 Harness 对比报告",
        brief: "根据会议纪要做 Harness 对比。traecli 和 trae ide 的代码本地已有，Doubao work 的代码要找张三要。",
        repos: [
          { name: "trae", cwd: trae, defaultBranch: "main" },
          { name: "doubao-work", cwd: doubao },
        ],
      }),
      tool("wait", { reason: "started" }),
    );
    // The project starts what it can and puts the missing piece on the owner.
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain(`doubao-work：${doubao}`);
        return tool("dispatch", { title: "分析 trae 的 Harness", instruction: `只读分析 ${trae} 的 Harness 设计，新建对比报告 artifact，报告它的 id。`, cwd: trae });
      },
      tool("track_action", { title: "要到 Doubao work 的代码", owner: "human", nextStep: `向张三要 Doubao work 的代码，放到 ${doubao} 后在这里勾掉` }),
      tool("send_message", { to: "channel:ui:owner", text: `Doubao work 的代码需要你向张三要一下，放到 ${doubao}。`, summary: "需要主人要代码" }),
      tool("wait", { reason: "等主人要到代码", waitingFor: "human" }),
    );
    let report = "";
    h.script.add(
      "worker",
      tool("save_artifact", { title: "Harness 对比报告", body: "# Harness 对比\n\n## trae\n- 基于事件循环" }),
      (req) => {
        report = artifactIdIn(lastToolResult(req));
        return tool("report_to_parent", { kind: "result", text: `trae 部分已分析，报告 ${report} v1。`, artifactId: report });
      },
    );
    h.script.add("project", tool("update_project", { summary: "trae 部分已完成，等 Doubao work 的代码" }));
    await h.ui.capture({ text: "/todo Harness 对比，会议纪要见飞书" });
    await h.kernel.idle();

    const [project] = projects(h);
    expect(h.kernel.getCell(project!)!.spec.cwd).toBeUndefined();
    expect(h.notices()).toContain(`Doubao work 的代码需要你向张三要一下，放到 ${doubao}。`);
    expect(h.kernel.listWaits([project!])).toEqual([expect.objectContaining({ waitingFor: "human" })]);
    const human = h.actions(project).find((a) => a.owner === "human")!;
    expect(human).toMatchObject({ status: "open", title: "要到 Doubao work 的代码" });
    expect(h.actions(project).find((a) => a.owner === "agent")).toMatchObject({ status: "done", artifactId: report });
    expect(h.kernel.context.getArtifactSync(report)).toMatchObject({ version: 1 });
    expect(h.kernel.anchorsOf(project!)).toMatchObject({ human: true, stalled: false });

    // The owner gets the code and ticks the action off in the app: the app writes the record and tells the project.
    mkdirSync(doubao, { recursive: true });
    const t = h.clock.now();
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("Doubao work 的代码已就绪");
        return tool("read_artifact", { artifactId: report });
      },
      tool("dispatch", {
        title: "补充 Doubao work 的分析",
        instruction: `只读分析 ${doubao} 的 Harness，把结论补进报告 ${report}（当前 v1）：先 read_artifact，再带 expectedVersion 保存，不要另起一份。`,
        cwd: doubao,
      }),
      {},
    );
    h.script.add(
      "worker",
      (req) => {
        expect(requestText(req)).toContain(report);
        return tool("read_artifact", { artifactId: report });
      },
      tool("save_artifact", { artifactId: report, expectedVersion: 1, title: "Harness 对比报告", body: "# Harness 对比\n\n## trae\n- 基于事件循环\n\n## Doubao work\n- 基于任务队列" }),
      (req) => {
        expect(lastToolResult(req)).toContain(`Saved ${report} v2`);
        return tool("report_to_parent", { kind: "result", text: `Doubao work 部分已补进报告 ${report} v2。`, artifactId: report });
      },
    );
    h.kernel.context.commitSync(project!, { statePatches: { [gtdKeys.action(human.id)]: { ...human, status: "done", completedAt: t, updatedAt: t } satisfies ActionRecord } });
    expect(notifyProjectOfOwnerChangeSync(h.kernel, project!, `主人已勾掉「${human.title}」：Doubao work 的代码已就绪，在 ${doubao}`)).toMatchObject({ status: "delivered" });
    await h.kernel.idle();

    expect(h.kernel.listWaits([project!])).toEqual([]); // the owner answered
    expect(h.kernel.context.getArtifactSync(report)).toMatchObject({ version: 2, updatedBy: "agent" });
    expect(h.kernel.context.getArtifactSync(report)!.content.body).toContain("## Doubao work");
    expect(h.actions(project).filter((a) => a.status === "open")).toEqual([]);
    expect(h.actions(project).filter((a) => a.owner === "agent").map((a) => [a.status, a.artifactId])).toEqual([
      ["done", report],
      ["done", report],
    ]);

    // A closed project is not told anything.
    await h.kernel.closeCell(project!, "completed");
    expect(notifyProjectOfOwnerChangeSync(h.kernel, project!, "还有一件事")).toBeNull();
  });
});
