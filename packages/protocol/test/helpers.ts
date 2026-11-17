import { cellsRepo, openDatabase, type CellInsert, type Db } from "../src";
import { ManualClock } from "../src/clock";

export function memDb(): Db {
  return openDatabase(":memory:");
}

export function seedCells(db: Db, clock = new ManualClock(1_000), cells: CellInsert[] = [{ id: "desk" }]) {
  const repo = cellsRepo(db, clock);
  for (const c of cells) repo.insert(c);
  return repo;
}
