/**
 * 极简 D1 替身：按 SQL 子串返回预设结果，覆盖 prepare/bind/first/all/run/batch。
 * 仅供单元测试使用，不改变被测代码行为。
 */
import type { Env } from '../../backend/env';

export type DbHandler = (sql: string, args: unknown[]) => unknown;

export interface MockDb extends Record<string, unknown> {
  __calls: { sql: string; args: unknown[] }[];
}

export function mockDb(handler: DbHandler): Env['DB'] {
  const calls: { sql: string; args: unknown[] }[] = [];

  const makeStmt = (sql: string, args: unknown[]) => ({
    bind: (...next: unknown[]) => makeStmt(sql, next),
    first: async () => {
      calls.push({ sql, args });
      const r = handler(sql, args);
      return Array.isArray(r) ? (r[0] ?? null) : (r ?? null);
    },
    all: async () => {
      calls.push({ sql, args });
      const r = handler(sql, args);
      return { results: Array.isArray(r) ? r : [] };
    },
    run: async () => {
      calls.push({ sql, args });
      return { success: true, meta: { last_row_id: 1, changes: 1 } };
    },
  });

  const db = {
    prepare: (sql: string) => {
      calls.push({ sql, args: [] });
      return makeStmt(sql, []);
    },
    batch: async (list: unknown[]) => list.map(() => ({ success: true, meta: { last_row_id: 1 } })),
    __calls: calls,
  };
  return db as unknown as Env['DB'];
}

/** 便捷断言：某条 SQL 是否被执行过（子串匹配） */
export function ranSql(db: Env['DB'], fragment: string): boolean {
  return ((db as unknown as MockDb).__calls ?? []).some((c) => c.sql.includes(fragment));
}
