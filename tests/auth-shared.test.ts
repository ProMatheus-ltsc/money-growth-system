/**
 * 认证收口回归测试
 *
 * 验证密码校验下沉 @shared/core 后：
 * 1. 存量账号（裸 hex 摘要 + 独立 salt 列）仍能校验通过——迁移最怕把老用户锁在门外
 * 2. 错误密码被拒绝
 * 3. 统一格式（盐内嵌在哈希串里）也能校验
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@shared/core/server/authCore';
import {
  derivePasswordHash,
  randomSaltHex,
  verifyPasswordColumn,
} from '../backend/lib/password';

describe('money-growth 密码校验（共享包统一实现）', () => {
  it('存量账号（裸摘要 + 独立 salt 列）仍能校验通过', async () => {
    const salt = randomSaltHex();
    const digest = await derivePasswordHash('oldpass', salt);
    await expect(verifyPasswordColumn('oldpass', digest, salt)).resolves.toBe(true);
    await expect(verifyPasswordColumn('wrongpass', digest, salt)).resolves.toBe(false);
  });

  it('统一格式（盐内嵌在哈希串里）也能校验', async () => {
    const stored = await hashPassword('unified-pass');
    await expect(verifyPasswordColumn('unified-pass', stored)).resolves.toBe(true);
    await expect(verifyPasswordColumn('nope', stored)).resolves.toBe(false);
  });

  it('缺少盐列时无法校验存量格式', async () => {
    const salt = randomSaltHex();
    const digest = await derivePasswordHash('oldpass', salt);
    await expect(verifyPasswordColumn('oldpass', digest)).resolves.toBe(false);
  });

  it('共享包的 verifyPassword 直接支持本项目的历史格式', async () => {
    const salt = randomSaltHex();
    const digest = await derivePasswordHash('oldpass', salt);
    // 不经过项目封装，共享包也应认这个格式
    await expect(verifyPassword('oldpass', digest, salt)).resolves.toBe(true);
  });

  it('每次生成的盐都不同', () => {
    expect(randomSaltHex()).not.toBe(randomSaltHex());
    expect(randomSaltHex()).toMatch(/^[0-9a-f]{32}$/);
  });
});
