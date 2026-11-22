import { all, artifactsRepo, run, type Clock, type Db, type ProjectProposal } from "@ng/protocol";

/** Runs inside StateDomain's migration transaction. Retain even an orphaned legacy record in searchable evidence. */
export function retireDeskState(db: Db, clock: Clock): void {
  run(
    db,
    `UPDATE cells SET spec=json_set(spec,'$.processor.entry','gtd.sensor_script','$.processor.args.script',substr(json_extract(spec,'$.processor.entry'),8))
    WHERE json_extract(spec,'$.processor.kind')='code' AND json_extract(spec,'$.processor.entry') GLOB 'script:?*'`,
  );
  const artifacts = artifactsRepo(db);
  const rows = all<{ cell_id: string; key: string; value: string; updated_at: number }>(
    db,
    "SELECT cell_id,key,value,updated_at FROM cell_state WHERE key GLOB 'desk:reply:*' OR key GLOB 'desk:proposal:*' OR key='desk:arbitration'",
  );
  for (const row of rows) {
    const text = `历史工作台记录 ${row.key}\n${row.value}`;
    run(db, "INSERT INTO evidence(cell_id,kind,content,text,at) VALUES(?,'external',?,?,?)", [
      row.cell_id,
      JSON.stringify({ kind: "external", source: row.key, text, at: row.updated_at }),
      text,
      row.updated_at,
    ]);
    if (row.key.startsWith("desk:proposal:")) {
      const id = row.key.slice("desk:proposal:".length);
      const artifact = artifacts.get(id);
      const legacy = JSON.parse(row.value);
      const plan = artifact?.content.data as ProjectProposal | undefined;
      if (artifact?.cellId === row.cell_id && plan && typeof plan === "object") {
        const fields = Object.fromEntries(
          ["cwd", "repos", "phases"].filter((k) => !(k in plan) && legacy[k] != null).map((k) => [k, legacy[k]]),
        );
        if (Object.keys(fields).length) {
          const data = { ...plan, ...fields };
          const content = JSON.stringify({ ...artifact.content, data, body: JSON.stringify(data, null, 2) });
          const version = artifact.version + 1;
          run(db, "INSERT INTO artifact_versions(artifact_id,version,content,updated_by,created_at,cell_id) VALUES(?,?,?,?,?,?)", [
            id,
            version,
            content,
            artifact.updatedBy,
            clock.now(),
            row.cell_id,
          ]);
          run(db, "UPDATE artifacts SET version=?,content=?,updated_at=? WHERE artifact_id=?", [version, content, clock.now(), id]);
          run(
            db,
            "UPDATE human_items SET bound_version=?,proposed_version=CASE WHEN ?='agent' THEN ? ELSE proposed_version END, human_edited=CASE WHEN ?='human' THEN 1 ELSE human_edited END,item_revision=item_revision+1 WHERE cell_id=? AND artifact_id=? AND action_type='project.start' AND disposition IN ('pending','approved')",
            [version, artifact.updatedBy, version, artifact.updatedBy, row.cell_id, id],
          );
        }
      }
    }
    run(db, "DELETE FROM cell_state WHERE cell_id=? AND key=?", [row.cell_id, row.key]);
  }
}
