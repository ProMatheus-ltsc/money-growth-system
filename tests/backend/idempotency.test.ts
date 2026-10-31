/**
 * 幂等键与登记表回归（契约 §2 E_DUP_IDEMPOTENT）：规范化稳定、键随内容变化、写后登记。
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  payloadFingerprint,
  idempotencyKey,
  IdempotencyLedger,
} from '../../scripts/mcp/idempotency.ts';

describe('canonicalize / fingerprint', () => {
  it('键序无关', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(payloadFingerprint({ b: 1, a: 2 })).toBe(payloadFingerprint({ a: 2, b: 1 }));
  });

  it('数组顺序敏感', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('null / 嵌套结构稳定', () => {
    expect(canonicalize({ x: [null, { y: true }] })).toBe('{"x":[null,{"y":true}]}');
  });
});

describe('idempotencyKey', () => {
  const input = { screenshotHash: 'abc', month: '2026-10', payload: { assets: [{ nodeId: 1, balanceCents: 100 }] } };

  it('同输入 → 同键（sha256 64 位）', () => {
    expect(idempotencyKey(input)).toBe(idempotencyKey(input));
    expect(idempotencyKey(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('换截图/月份/载荷 → 不同键', () => {
    expect(idempotencyKey({ ...input, screenshotHash: 'def' })).not.toBe(idempotencyKey(input));
    expect(idempotencyKey({ ...input, month: '2026-09' })).not.toBe(idempotencyKey(input));
    expect(idempotencyKey({ ...input, payload: { assets: [] } })).not.toBe(idempotencyKey(input));
  });
});

describe('IdempotencyLedger', () => {
  it('写成功后登记；命中返回既有结果', () => {
    const ledger = new IdempotencyLedger();
    expect(ledger.lookup('k')).toBeNull();
    ledger.record('k', { written: true });
    expect(ledger.has('k')).toBe(true);
    expect(ledger.lookup('k')).toEqual({ written: true });
    ledger.clear();
    expect(ledger.lookup('k')).toBeNull();
  });
});
