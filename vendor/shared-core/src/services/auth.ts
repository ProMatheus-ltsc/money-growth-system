/**
 * 本地账户认证：PBKDF2-SHA256 密码哈希
 * 三项目共用
 */
import { v4 as uuidv4 } from 'uuid';
import type { Account } from '../types';
import { createAccount, getAccountByUsername } from './db';

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

function randomSaltHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

async function derivePasswordHash(password: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(derivedBits);
}

export async function registerAccount(username: string, password: string): Promise<Account> {
  const existing = await getAccountByUsername(username);
  if (existing) {
    throw new Error('用户名已存在');
  }
  const salt = randomSaltHex();
  const passwordHash = await derivePasswordHash(password, salt);
  const account: Account = {
    id: uuidv4(),
    username,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };
  await createAccount(account);
  return account;
}

export async function verifyAccountPassword(
  username: string,
  password: string
): Promise<Account | undefined> {
  const account = await getAccountByUsername(username);
  if (!account) return undefined;
  const hash = await derivePasswordHash(password, account.salt);
  return hash === account.passwordHash ? account : undefined;
}

export async function resetAccountPassword(
  username: string,
  newPassword: string
): Promise<Account> {
  const account = await getAccountByUsername(username);
  if (!account) {
    throw new Error('用户名不存在');
  }
  const salt = randomSaltHex();
  const passwordHash = await derivePasswordHash(newPassword, salt);
  const updated: Account = { ...account, salt, passwordHash };
  await createAccount(updated);
  return updated;
}
