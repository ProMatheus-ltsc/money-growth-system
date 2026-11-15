/**
 * 共享包 D1 访问层的真实 SQLite 测试
 *
 * 覆盖各项目后端重复实现、现在收归到共享包的部分：
 * - 分批执行（D1 单次 batch 有语句数上限）
 * - 表结构探测（schema 自愈 / 迁移校验要用）
 * - 行数统计、查询便捷封装、探活
 *
 * 用真 SQLite（node:sqlite）而不是 mock：mock 抓不到 SQL 本身写错的情况。
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  countRows,
  D1_MAX_BATCH_STATEMENTS,
  execute,
  hasColumn,
  ping,
  queryAll,
  queryFirst,
  runBatches,
  runBatchesWithResults,
  tableColumns,
  tableExists,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "@shared/core/server/d1";

/**
 * node:sqlite 是 Node 内置模块，Vite 的解析器会把它当包名去找。
 * 用 createRequire 绕过 Vite 的解析，直接拿 Node 原生模块。
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

/** 把 node:sqlite 适配成共享包的 D1 接口 */
function createD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(query: string): D1PreparedStatementLike {
      const statement = db.prepare(query);
      const run = (...values: unknown[]) => statement.run(...(values as never[]));
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              run(...values);
              return { success: true };
            },
            async first<T>() {
              return (statement.get(...(values as never[])) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: statement.all(...(values as never[])) as T[] };
            },
          };
        },
        async run() {
          run();
          return { success: true };
        },
        async first<T>() {
          return (statement.get() as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: statement.all() as T[] };
        },
      };
    },
    async batch(statements: D1PreparedStatementLike[]) {
      // node:sqlite 没有 batch，逐条执行（语义等价，本测试不依赖原子性）
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("共享包 D1 访问层", () => {
  it("分批执行：语句数超过单批上限时会自动分批", async () => {
    const db = createDb();
    const d1 = createD1(db);
    const statements: D1PreparedStatementLike[] = [];
    for (let index = 0; index < D1_MAX_BATCH_STATEMENTS + 5; index += 1) {
      statements.push(
        d1
          .prepare("INSERT INTO items (id,name,updated_at) VALUES (?,?,?)")
          .bind(`id_${index}`, `name_${index}`, new Date().toISOString()),
      );
    }
    await runBatches(d1, statements);
    expect(await countRows(d1, "items")).toBe(D1_MAX_BATCH_STATEMENTS + 5);
  });

  it("分批执行：空数组直接返回，不调用 batch", async () => {
    const d1 = createD1(createDb());
    let batchCalled = false;
    await runBatches(
      { ...d1, batch: async () => { batchCalled = true; return []; } },
      [],
    );
    expect(batchCalled).toBe(false);
  });

  it("分批执行：句柄没有 batch 时抛明确错误", async () => {
    const d1 = createD1(createDb());
    const withoutBatch = {
      prepare: d1.prepare.bind(d1),
    } as D1DatabaseLike;
    await expect(
      runBatches(withoutBatch, [
        d1.prepare("INSERT INTO items (id,name,updated_at) VALUES (?,?,?)").bind("a", "a", "t"),
      ]),
    ).rejects.toThrow(/没有 batch 方法/);
  });

  it("分批执行并返回逐条结果", async () => {
    const d1 = createD1(createDb());
    const statements = [
      d1.prepare("INSERT INTO items (id,name,updated_at) VALUES (?,?,?)").bind("a", "a", "t"),
      d1.prepare("INSERT INTO items (id,name,updated_at) VALUES (?,?,?)").bind("b", "b", "t"),
    ];
    const results = await runBatchesWithResults<{ success: boolean }>(d1, statements);
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
  });

  it("探测表结构：列名、表是否存在、列是否存在", async () => {
    const d1 = createD1(createDb());
    expect(await tableColumns(d1, "items")).toEqual(["id", "name", "updated_at"]);
    expect(await tableExists(d1, "items")).toBe(true);
    expect(await tableExists(d1, "no_such_table")).toBe(false);
    expect(await hasColumn(d1, "items", "name")).toBe(true);
    expect(await hasColumn(d1, "items", "nope")).toBe(false);
  });

  it("统计行数：可带 WHERE 子句", async () => {
    const d1 = createD1(createDb());
    await execute(
      d1,
      "INSERT INTO items (id,name,updated_at) VALUES (?,?,?)",
      "a",
      "keep",
      new Date().toISOString(),
    );
    await execute(
      d1,
      "INSERT INTO items (id,name,updated_at) VALUES (?,?,?)",
      "b",
      "drop",
      new Date().toISOString(),
    );
    expect(await countRows(d1, "items")).toBe(2);
    expect(await countRows(d1, "items", "name = 'keep'")).toBe(1);
  });

  it("查询便捷封装：queryAll / queryFirst", async () => {
    const d1 = createD1(createDb());
    await execute(
      d1,
      "INSERT INTO items (id,name,updated_at) VALUES (?,?,?)",
      "a",
      "first",
      new Date().toISOString(),
    );
    const rows = await queryAll<{ id: string; name: string }>(
      d1,
      "SELECT id,name FROM items WHERE id = ?",
      "a",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("first");

    const one = await queryFirst<{ name: string }>(
      d1,
      "SELECT name FROM items WHERE id = ?",
      "a",
    );
    expect(one?.name).toBe("first");

    const missing = await queryFirst(d1, "SELECT name FROM items WHERE id = ?", "nope");
    expect(missing).toBeNull();
  });

  it("探活：库通则 true，不通则 false（不抛错）", async () => {
    const d1 = createD1(createDb());
    expect(await ping(d1)).toBe(true);

    const broken = {
      prepare: () => {
        throw new Error("database unavailable");
      },
    } as unknown as D1DatabaseLike;
    expect(await ping(broken)).toBe(false);
  });
});
