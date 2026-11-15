/**
 * PBKDF2-SHA-256 密码哈希 —— 收归 @shared/core 的统一认证实现。
 *
 * 本文件曾自建一份实现（与 shared-core 的旧 services/auth.ts 算法一致）。
 * 现在哈希本身下沉到 `@shared/core/server/authCore`，本文件只保留
 * 本项目的调用形态：
 *
 * - `derivePasswordHash(password, saltHex)` → 裸 hex 摘要（不含盐）
 *   —— 本项目 users 表的 salt 是独立列，格式与其它项目不同；
 *   共享包的 `verifyPassword` 同时认「裸摘要 + 独立 salt 列」这一历史格式，
 *   因此老用户无需重置密码。
 * - `randomSaltHex()` → 16 字节随机盐（hex）
 * - `newToken()` → 会话令牌
 *
 * 另附 `hashPasswordForColumn` / `verifyPasswordColumn`：写入统一格式
 * （盐内嵌在哈希串里），供新建账号使用——共享包的统一契约。
 */
import {
  generateSessionToken,
  hashPassword,
  verifyPassword,
} from '@shared/core/server/authCore';
import type { AuthUserRow } from '@shared/core/server/authDb';

const PBKDF2_ITERATIONS = 100_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): ArrayBuffer {
  const bytes = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(bytes.map((b) => parseInt(b, 16))).buffer;
}

export function randomSaltHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

export async function derivePasswordHash(password: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    256
  );
  return toHex(derivedBits);
}

export function newToken(): string {
  return generateSessionToken();
}

/**
 * 写入统一格式（盐内嵌在哈希串里）——共享包的统一契约。
 * 供后续把本项目的 users 表迁到统一 schema 时使用。
 */
export async function hashPasswordForColumn(password: string): Promise<string> {
  return hashPassword(password);
}

/**
 * 校验密码：认共享包的全部历史格式（含本项目的「裸摘要 + 独立 salt 列」）。
 */
export async function verifyPasswordColumn(
  password: string,
  stored: string | null,
  legacySalt?: string | null,
): Promise<boolean> {
  return verifyPassword(password, stored, legacySalt);
}

/** 供类型检查：本项目 users 表的行形态 */
export type MoneyUserRow = AuthUserRow;
