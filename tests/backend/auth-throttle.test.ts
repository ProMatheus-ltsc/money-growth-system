/**
 * 鉴权限速与口令散列回归（REQ-003 / REQ-006 / F-005）。
 * 覆盖：PBKDF2 同盐确定性（站点口令散列）。
 */
import { describe, it, expect } from 'vitest';
import { derivePasswordHash, randomSaltHex } from '../../backend/lib/password.ts';
/* 鉴权策略/凭据掩码/出站白名单等 Agent 侧用例已迁移到独立仓 money-growth-agent。 */

describe('derivePasswordHash（PBKDF2-SHA256，100k 迭代）', () => {
  it('同口令同盐 → 同哈希（可重入验证）', async () => {
    const salt = randomSaltHex();
    const a = await derivePasswordHash('demo-pass', salt);
    const b = await derivePasswordHash('demo-pass', salt);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同口令不同盐 → 不同哈希', async () => {
    const h1 = await derivePasswordHash('demo-pass', randomSaltHex());
    const h2 = await derivePasswordHash('demo-pass', randomSaltHex());
    expect(h1).not.toBe(h2);
  });

  it('不同口令 → 不同哈希', async () => {
    const salt = randomSaltHex();
    expect(await derivePasswordHash('a', salt)).not.toBe(await derivePasswordHash('b', salt));
  });
});
