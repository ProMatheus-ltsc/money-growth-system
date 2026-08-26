/**
 * PBKDF2-SHA-256 密码哈希（100k 迭代，Web Crypto）。
 * 与 @shared/core services/auth.ts（pin 911aff9）算法完全一致——服务端实现直接移植，
 * 保证前后端口径同源（04 §3.9 行 1 附加复用）。
 */
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
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(derivedBits);
}

export function newToken(): string {
  // 128bit 随机 × 2（04 §4.2 sessions）
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
}
