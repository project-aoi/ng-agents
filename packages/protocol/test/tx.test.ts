import { describe, expect, it } from "vitest";
import { afterCommit, get, inTransaction, isNgError, openDatabase, run, withTx, type Db } from "../src";

function db(): Db {
  const d = openDatabase(":memory:");
  d.exec("CREATE TABLE t (v TEXT)");
  return d;
}
const count = (d: Db) => get<{ n: number }>(d, "SELECT count(*) AS n FROM t")!.n;
const values = (d: Db) => (d.prepare("SELECT v FROM t ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v);

describe("withTx", () => {
  it("commits and returns the callback's value", () => {
    const d = db();
    const r = withTx(d, () => {
      run(d, "INSERT INTO t VALUES ('a')");
      expect(inTransaction(d)).toBe(true);
      return 42;
    });
    expect(r).toBe(42);
    expect(inTransaction(d)).toBe(false);
    expect(count(d)).toBe(1);
  });

  it("rolls back everything when the callback throws", () => {
    const d = db();
    expect(() =>
      withTx(d, () => {
        run(d, "INSERT INTO t VALUES ('a')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count(d)).toBe(0);
    expect(d.isTransaction).toBe(false);
  });

  it("nested savepoint rollback keeps the outer transaction's work", () => {
    const d = db();
    withTx(d, () => {
      run(d, "INSERT INTO t VALUES ('outer-1')");
      expect(() =>
        withTx(d, () => {
          run(d, "INSERT INTO t VALUES ('inner')");
          throw new Error("inner fails");
        }),
      ).toThrow("inner fails");
      withTx(d, () => run(d, "INSERT INTO t VALUES ('inner-ok')"));
      run(d, "INSERT INTO t VALUES ('outer-2')");
    });
    expect(values(d)).toEqual(["outer-1", "inner-ok", "outer-2"]);
  });

  it("outer rollback discards a released inner savepoint", () => {
    const d = db();
    expect(() =>
      withTx(d, () => {
        withTx(d, () => run(d, "INSERT INTO t VALUES ('inner')"));
        throw new Error("outer fails");
      }),
    ).toThrow("outer fails");
    expect(count(d)).toBe(0);
  });

  it("rejects async callbacks and rolls back", () => {
    const d = db();
    let caught: unknown;
    try {
      withTx(d, (async () => {
        run(d, "INSERT INTO t VALUES ('a')");
      }) as unknown as () => void);
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "tx_misuse")).toBe(true);
    expect(count(d)).toBe(0);
  });
});

describe("afterCommit", () => {
  it("runs immediately outside a transaction", () => {
    const d = db();
    const seen: string[] = [];
    afterCommit(d, () => seen.push("now"));
    expect(seen).toEqual(["now"]);
  });

  it("defers to the outermost commit, in registration order", () => {
    const d = db();
    const seen: string[] = [];
    withTx(d, () => {
      afterCommit(d, () => seen.push(`outer:${count(d)}`));
      withTx(d, () => {
        run(d, "INSERT INTO t VALUES ('x')");
        afterCommit(d, () => seen.push("inner"));
      });
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["outer:1", "inner"]);
  });

  it("drops callbacks of a rolled-back savepoint or transaction", () => {
    const d = db();
    const seen: string[] = [];
    withTx(d, () => {
      afterCommit(d, () => seen.push("kept"));
      try {
        withTx(d, () => {
          afterCommit(d, () => seen.push("dropped-inner"));
          throw new Error("x");
        });
      } catch {
        // expected
      }
    });
    try {
      withTx(d, () => {
        afterCommit(d, () => seen.push("dropped-outer"));
        throw new Error("y");
      });
    } catch {
      // expected
    }
    expect(seen).toEqual(["kept"]);
  });
});
