/**
 * 认证数据运维清理回归（P2）：过期 session/gate_token 清理、陈旧 IP 计行清理、
 * 审计日志保留期裁剪，以及「锁定中的 IP 行必须保留」这条安全边界。
 */
import { describe, it, expect } from 'vitest';
import { pruneStaleAuthRows } from '../../backend/services/maintenance.ts';
import { mockDb, ranSql } from '../helpers/mockD1.ts';

const NOW = new Date('2026-11-12T10:00:00Z');

function dbWithCounts(changes: number[]) {
  // batch 结果按顺序返回 meta.changes，便于断言汇总统计
  const db = mockDb(() => null) as unknown as Record<string, unknown> & {
    batch: (list: unknown[]) => Promise<unknown[]>;
  };
  let i = 0;
  db.batch = async () => changes.map((c) => ({ success: true, meta: { changes: c } }));
  void i;
  return db as never;
}

describe('pruneStaleAuthRows', () => {
  it('四类清理都执行，并返回各表删除行数', async () => {
    const db = dbWithCounts([5, 2, 3, 4]);
    const res = await pruneStaleAuthRows(db, NOW);
    expect(res).toEqual({ sessions: 5, gateTokens: 2, ipRateLimit: 3, loginAudit: 4 });
    expect(ranSql(db, 'DELETE FROM sessions WHERE expires_at <')).toBe(true);
    expect(ranSql(db, 'DELETE FROM gate_tokens WHERE expires_at <')).toBe(true);
    expect(ranSql(db, 'DELETE FROM ip_rate_limit')).toBe(true);
    expect(ranSql(db, 'DELETE FROM login_audit_log')).toBe(true);
  });

  it('IP 计数清理必须保留锁定中的行（否则可绕过限流）', async () => {
    const db = dbWithCounts([0, 0, 0, 0]);
    await pruneStaleAuthRows(db, NOW);
    const sql = ((db as unknown as { __calls: { sql: string }[] }).__calls ?? [])
      .map((c) => c.sql)
      .find((s) => s.includes('DELETE FROM ip_rate_limit')) ?? '';
    // 只有「未锁定」或「锁已过期」的行才会被删
    expect(sql).toContain('locked_until IS NULL OR locked_until <');
  });

  it('清理失败不抛出（尽力而为，不阻断登录流程）', async () => {
    const db = mockDb(() => null) as unknown as { batch: () => Promise<unknown[]> };
    db.batch = async () => {
      throw new Error('D1 unavailable');
    };
    const res = await pruneStaleAuthRows(db as never, NOW);
    expect(res).toEqual({ sessions: 0, gateTokens: 0, ipRateLimit: 0, loginAudit: 0 });
  });
});
