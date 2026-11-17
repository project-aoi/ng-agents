import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import { parseSkillFile, serializeSkillFile, skillFilePath } from "../src";
import { setup } from "./helpers";

describe("SKILL.md files", () => {
  it("serialize → parse round-trips exactly, including Chinese, colons and odd bodies", () => {
    for (const body of ["# 周回顾\n\n1. 对比改稿习惯\n2. 提炼规则\n", "", "\nstarts with a blank line", "no trailing newline", "---\nnot front matter\n---\n"]) {
      const skill = { name: "weekly-review", description: "周回顾: 对比本周改稿习惯 #tag", tags: ["gtd", "回顾"], body, extra: { license: "MIT" } };
      const parsed = parseSkillFile(serializeSkillFile(skill));
      expect(parsed).toEqual(skill);
    }
  });

  it("reads human-written files (no blank line, CRLF, BOM, comma tags)", () => {
    expect(parseSkillFile("﻿---\r\nname: x\r\ndescription: d\r\ntags: a, b\r\n---\r\nbody\r\n")).toMatchObject({
      name: "x",
      description: "d",
      tags: ["a", "b"],
      body: "body\r\n",
    });
    expect(() => parseSkillFile("no front matter")).toThrow(/front matter/);
    expect(() => parseSkillFile("---\nname: [unclosed\n---\n")).toThrow(/YAML/);
  });
});

describe("upsertSkillOrNote", () => {
  it("writes a skill file with front matter and keeps the index row in sync", async () => {
    const h = setup();
    await h.store.upsertSkillOrNote("desk", {
      kind: "skill",
      scope: "global",
      name: "weekly-review",
      description: "每周五整理完结事项并提炼 SKILL",
      body: "# 周回顾\n\n1. 汇总本周完结事项\n",
      tags: ["gtd"],
      mode: "upsert",
    });
    const path = skillFilePath(h.dataDir, "weekly-review", null);
    expect(path).toBe(join(h.dataDir, "skills", "weekly-review", "SKILL.md"));
    const file = readFileSync(path, "utf8");
    expect(file.startsWith("---\nname: weekly-review\ndescription: 每周五整理完结事项并提炼 SKILL\ntags:\n  - gtd\n---\n\n# 周回顾")).toBe(true);
    expect(h.store.getKnowledgeSync({ kind: "skill", scope: "global", name: "weekly-review" })).toMatchObject({
      description: "每周五整理完结事项并提炼 SKILL",
      body: "# 周回顾\n\n1. 汇总本周完结事项\n",
      tags: ["gtd"],
      cellId: null,
    });
    expect(h.store.listSkillsSync()).toEqual([{ name: "weekly-review", description: "每周五整理完结事项并提炼 SKILL", scope: "global", tags: ["gtd"] }]);
    expect(h.store.readResourceSync("desk", "skill://weekly-review")).toBe("# 周回顾\n\n1. 汇总本周完结事项\n");
    expect(h.events.map((e) => e.topic)).toContain("knowledge.changed");

    // append keeps description and adds a line; other front matter keys survive a rewrite
    writeFileSync(path, readFileSync(path, "utf8").replace("tags:", "license: MIT\ntags:"));
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "weekly-review", body: "2. 提炼规则", mode: "append" });
    const parsed = parseSkillFile(readFileSync(path, "utf8"));
    expect(parsed).toMatchObject({ description: "每周五整理完结事项并提炼 SKILL", body: "# 周回顾\n\n1. 汇总本周完结事项\n2. 提炼规则", extra: { license: "MIT" } });

    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "weekly-review", mode: "delete" });
    expect(existsSync(path)).toBe(false);
    expect(h.store.listSkillsSync()).toEqual([]);
  });

  it("validates skill names and required fields", () => {
    const h = setup();
    const bad = (patch: object) => {
      try {
        h.store.upsertSkillOrNoteSync("desk", patch as never);
      } catch (e) {
        return isNgError(e, "invalid_argument");
      }
      return false;
    };
    expect(bad({ kind: "skill", scope: "global", name: "../etc", description: "d", body: "b", mode: "upsert" })).toBe(true);
    expect(bad({ kind: "skill", scope: "global", name: "Weekly Review", description: "d", body: "b", mode: "upsert" })).toBe(true);
    expect(bad({ kind: "note", scope: "global", name: "n", body: "b", mode: "upsert" })).toBe(true);
    expect(bad({ kind: "note", scope: "global", name: "n", description: "d", mode: "append" })).toBe(true);
    expect(bad({ kind: "fact", scope: "global", name: "n", description: "d", body: "b", mode: "upsert" })).toBe(true);
  });

  it("notes and preferences live in the database, scoped per cell with ancestor inheritance", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "p", parentId: "desk" }, { id: "w", parentId: "p" }, { id: "x", parentId: "desk" }] });
    h.store.upsertSkillOrNoteSync("p", { kind: "note", scope: "cell", name: "供应商联系人", description: "联系人", body: "A: 张三", mode: "upsert" });
    h.store.upsertSkillOrNoteSync("w", { kind: "note", scope: "global", name: "牙医", description: "电话", body: "周五下午", mode: "upsert" });
    expect(h.store.getKnowledgeSync({ kind: "note", scope: "cell", cellId: "p", name: "供应商联系人" })?.body).toBe("A: 张三");
    expect(h.store.readResourceSync("w", "note://供应商联系人")).toBe("A: 张三");
    expect(h.store.readResourceSync("w", `note://${encodeURIComponent("供应商联系人")}`)).toBe("A: 张三");
    expect(h.store.readResourceSync("x", "note://牙医")).toBe("周五下午");
    expect(() => h.store.readResourceSync("x", "note://供应商联系人")).toThrow(/not found/);
    expect(h.store.listKnowledgeSync({ cellId: "p" }).map((k) => k.name)).toEqual(["供应商联系人", "牙医"]);
    expect(h.store.listKnowledgeSync({ cellId: "p", includeGlobal: false }).map((k) => k.name)).toEqual(["供应商联系人"]);
    // nearest scope wins on a name clash
    h.store.upsertSkillOrNoteSync("w", { kind: "note", scope: "cell", name: "牙医", description: "电话", body: "改到周六", mode: "upsert" });
    expect(h.store.readResourceSync("w", "note://牙医")).toBe("改到周六");
    expect(h.store.readResourceSync("p", "note://牙医")).toBe("周五下午");
    expect(existsSync(join(h.dataDir, "skills"))).toBe(false);
  });

  it("cell-scoped skills get their own directory", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "proj.1", parentId: "desk" }] });
    h.store.upsertSkillOrNoteSync("proj.1", { kind: "skill", scope: "cell", name: "ci-fix", description: "修 CI", body: "steps", mode: "upsert" });
    const path = skillFilePath(h.dataDir, "ci-fix", "proj.1");
    expect(path).toBe(join(h.dataDir, "skills", "_cells", "proj%2E1", "ci-fix", "SKILL.md"));
    expect(existsSync(path)).toBe(true);
    expect(h.store.listSkillsSync("proj.1").map((s) => [s.name, s.scope])).toEqual([["ci-fix", "cell"]]);
    expect(h.store.listSkillsSync("desk")).toEqual([]);
  });
});

describe("rescanSkills", () => {
  it("picks up manual edits, new skill directories and deletions; keeps rows of broken files", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }] });
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "reply-style", description: "回复风格", body: "简洁", mode: "upsert" });
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "triage", description: "分拣", body: "规则", mode: "upsert" });
    h.store.upsertSkillOrNoteSync("w", { kind: "skill", scope: "cell", name: "local", description: "本地", body: "x", mode: "upsert" });

    const replyPath = skillFilePath(h.dataDir, "reply-style", null);
    writeFileSync(replyPath, "---\nname: reply-style\ndescription: 回复风格（手改）\n---\n先给结论，再给依据。\n");
    const newDir = join(h.dataDir, "skills", "pr-summary");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "SKILL.md"), "---\nname: pr-summary\ndescription: PR 摘要\n---\n\n列出改动与风险\n");
    writeFileSync(skillFilePath(h.dataDir, "triage", null), "---\nname: [broken\n---\n");
    rmSync(join(h.dataDir, "skills", "_cells", "w", "local"), { recursive: true });
    mkdirSync(join(h.dataDir, "skills", "Bad Name"));
    writeFileSync(join(h.dataDir, "skills", "Bad Name", "SKILL.md"), "---\nname: x\ndescription: y\n---\n");

    const report = h.store.rescanSkillsSync();
    expect(report.added).toEqual(["pr-summary"]);
    expect(report.updated).toEqual(["reply-style"]);
    expect(report.removed).toEqual(["w/local"]);
    expect(report.errors.map((e) => e.message).join("\n")).toMatch(/not a valid skill name[\s\S]*YAML/);
    expect(h.store.getKnowledgeSync({ kind: "skill", scope: "global", name: "reply-style" })).toMatchObject({
      description: "回复风格（手改）",
      body: "先给结论，再给依据。\n",
    });
    expect(h.store.getKnowledgeSync({ kind: "skill", scope: "global", name: "triage" })?.body).toBe("规则");
    expect(h.store.listSkillsSync("w").map((s) => s.name)).toEqual(["pr-summary", "reply-style", "triage"]);

    const again = h.store.rescanSkillsSync();
    expect([again.added, again.updated, again.removed]).toEqual([[], [], []]);
  });

  it("indexes skill files that exist before the store is created", () => {
    const h = setup();
    const dir = join(h.dataDir, "skills", "standup");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: standup\ndescription: 早会摘要\n---\n\n要点\n");
    const store = h.makeStore();
    expect(store.listSkillsSync()).toEqual([{ name: "standup", description: "早会摘要", scope: "global", tags: [] }]);
    expect(store.readResourceSync("desk", "skill://standup")).toBe("要点\n");
  });
});
