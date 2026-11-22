import { expect, it } from "vitest";
import { meta, setup, proposal, withWorker, putArtifact } from "./helpers";

it("binds decisions to the issuer, its epoch, its lineage and the proposed artifact version", () => {
  const f = setup();
  withWorker(f);
  const action = proposal();
  expect(f.gate.authorizeSync(action, meta("missing")).type).toBe("deny");
  expect(f.gate.authorizeSync(action, meta("w1", 1)).type).toBe("deny");
  expect(f.gate.authorizeSync(action, { ...meta("w1"), principalId:"cell:desk" }).type).toBe("deny");
  f.cells.setStatus("desk", "paused");
  expect(f.gate.authorizeSync(action, meta("w1")).type).toBe("deny");
  f.cells.setStatus("desk", "active");
  f.addCell("other", null);
  putArtifact(f.db, {artifactId:"plan", cellId:"w1", version:1, body:"草稿"});
  const draft = proposal({artifactId:"plan",sideEffect:"none"});
  expect(f.gate.authorizeSync(draft, meta("other")).type).toBe("deny");
  expect(f.gate.authorizeSync(draft, meta("desk", 0, {artifactVersion:2})).type).toBe("deny");
  const first = f.gate.authorizeSync(draft, meta("desk"));
  expect(first).toMatchObject({type:"defer",boundArtifactVersion:1});
  expect(f.gate.authorizeSync(draft, meta("desk"))).toEqual(first);
  const child = f.gate.authorizeSync(draft, meta("w1"));
  expect(child).toMatchObject({type:"defer",boundArtifactVersion:1});
  if (first.type !== "defer" || child.type !== "defer") throw Error("both cells need independent decisions");
  expect(child.actionId).not.toBe(first.actionId);
  expect(f.gate.findPendingBySubjectSync(draft.subjectKey, "desk")?.actionId).toBe(first.actionId);
  expect(f.gate.findPendingBySubjectSync(draft.subjectKey, "w1")?.actionId).toBe(child.actionId);
  expect(f.gate.listPendingSync()).toHaveLength(2);
});
