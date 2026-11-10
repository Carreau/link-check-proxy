/** Minimal D1-compatible shim over node:sqlite, for tests. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, Stmt } from "../src/store.js";

type SqlValue = null | number | bigint | string | Uint8Array;

class ShimStmt implements Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: SqlValue[] = [],
  ) {}
  bind(...values: unknown[]): Stmt {
    return new ShimStmt(this.db, this.sql, values as SqlValue[]);
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async run(): Promise<{ meta: { changes?: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
  /** Used by batch: SELECTs return rows, others run. */
  exec(): unknown {
    const s = this.db.prepare(this.sql);
    if (/^\s*select/i.test(this.sql)) return { results: s.all(...this.params) };
    const r = s.run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
}

export function createTestDb(): Db & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return {
    raw: db,
    prepare: (sql) => new ShimStmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as ShimStmt).exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
