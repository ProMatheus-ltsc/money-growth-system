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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, parseEnvFile } from '../../scripts/mcp/api-client.ts';

describe('loadCredentials（空白环境变量不遮蔽 env 文件）', () => {
  it('空白串视为未设置，回落 env 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgs-cred-'));
    const file = join(dir, 'money.env');
    writeFileSync(
      file,
      ['# comment', 'MGS_URL=https://example.test', 'MGS_INVITE_CODE=CODE1', 'MGS_USERNAME=user1', 'MGS_PASSWORD=pass1'].join('\n')
    );
    try {
      const creds = loadCredentials({ MGS_ENV: file, MGS_URL: '', MGS_USERNAME: '   ' });
      expect(creds.baseUrl).toBe('https://example.test');
      expect(creds.inviteCode).toBe('CODE1');
      expect(creds.username).toBe('user1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺变量报 E_SCHEMA 且只回显变量名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgs-cred-'));
    try {
      expect(() => loadCredentials({ MGS_ENV: join(dir, 'missing.env') })).toThrowError(/MGS_URL/);
      try {
        loadCredentials({ MGS_ENV: join(dir, 'missing.env') });
      } catch (e) {
        expect((e as { code?: string }).code).toBe('E_SCHEMA');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseEnvFile 处理引号与注释', () => {
    expect(parseEnvFile('# x\nA=1\nB="2 3"\n')).toEqual({ A: '1', B: '2 3' });
  });
});
