/**
 * 鉴权限速与口令散列回归（REQ-003 / REQ-006 / F-005）。
 * 覆盖：PBKDF2 同盐确定性、authFailurePolicy 熔断分支、凭据掩码。
 */
import { describe, it, expect } from 'vitest';
import { derivePasswordHash, randomSaltHex } from '../../backend/lib/password.ts';
import { authFailurePolicy, maskSecret } from '../../scripts/mcp/api-client.ts';

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

describe('authFailurePolicy', () => {
  it('LOCKED_OUT(423) → 熔断不重试', () => {
    expect(authFailurePolicy(423, 'LOCKED_OUT')).toBe('stop_locked');
  });
  it('会话过期(401) → 允许一次自动重登', () => {
    expect(authFailurePolicy(401, 'UNAUTHORIZED')).toBe('relogin_once');
    expect(authFailurePolicy(403, 'GATE_EXPIRED')).toBe('relogin_once');
  });
  it('其它 → 直接上抛', () => {
    expect(authFailurePolicy(500, 'INTERNAL')).toBe('fail');
    expect(authFailurePolicy(403, 'FORBIDDEN')).toBe('fail');
  });
});

describe('maskSecret', () => {
  it('仅保留前 3 位，绝不泄露明文', () => {
    const secret = 'Sup3r-Secret-Pass';
    const masked = maskSecret(secret);
    expect(masked).toBe('Sup***');
    expect(masked).not.toContain('cret');
  });
  it('未配置 → <unset>', () => {
    expect(maskSecret(undefined)).toBe('<unset>');
  });
});
