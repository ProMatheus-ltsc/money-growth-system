/**
 * 幂等键计算（COMP-001）。
 * 键 = sha256( 截图内容哈希 + 目标月份 + 录入载荷指纹 )，用于同一截图重复提交去重。
 * 纯函数、无网络、无凭据，可脱离站点单测。
 */
import { createHash } from 'node:crypto';

export interface IdempotencyInput {
  /** 截图原始字节内容哈希（sha256 hex） */
  screenshotHash: string;
  /** 目标月份 YYYY-MM */
  month: string;
  /** 规范化后的录入载荷 */
  payload: unknown;
}

/** 递归稳定序列化：对象按键升序，避免键顺序不同导致指纹漂移 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/** 载荷指纹：对规范化 JSON 取 sha256 */
export function payloadFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/** 计算幂等键（sha256 hex，64 位） */
export function idempotencyKey(input: IdempotencyInput): string {
  const fp = payloadFingerprint(input.payload);
  return createHash('sha256')
    .update(`${input.screenshotHash}|${input.month}|${fp}`)
    .digest('hex');
}

/**
 * 进程内幂等登记表。仅在写成功（或确证命中既有结果）后 record，
 * 写失败不得登记，避免把「从未写入」误报为幂等命中。
 */
export class IdempotencyLedger {
  private readonly results = new Map<string, Record<string, unknown>>();

  record(key: string, result: Record<string, unknown>): void {
    this.results.set(key, result);
  }

  lookup(key: string): Record<string, unknown> | null {
    return this.results.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.results.has(key);
  }

  clear(): void {
    this.results.clear();
  }
}
