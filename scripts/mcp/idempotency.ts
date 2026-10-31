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
 * 内存幂等登记表（进程内去重）。落盘由调用方决定，本模块保持无副作用以便单测。
 * markIfAbsent 返回 true 表示首次登记；false 表示命中既有键（应转 E_DUP_IDEMPOTENT 读回比对）。
 */
export class IdempotencyLedger {
  private readonly seen = new Set<string>();

  markIfAbsent(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  clear(): void {
    this.seen.clear();
  }
}
