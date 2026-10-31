/**
 * 录入载荷 schema 校验回归（REQ-001 / 契约 §2 E_SCHEMA）。
 * 直接读取 config/recorder.schema.json，锁定「分整数」与字段白名单。
 */
import { describe, it, expect } from 'vitest';
import { validateRecorderPayload, loadRecorderSchema } from '../../scripts/mcp/schema.ts';

const base = {
  month: '2026-10',
  treeConfigId: 3,
  catConfigId: 5,
  assets: [{ nodeId: 11, balanceCents: 123456, hasNewFunds: false, updateSource: 'current' }],
  debts: [{ debtId: 1, balanceCents: 500000, repaymentCents: 20000 }],
};

describe('validateRecorderPayload', () => {
  it('最小合法载荷通过', () => {
    expect(validateRecorderPayload(base)).toEqual([]);
  });

  it('金额必须为分整数：小数被拒绝', () => {
    const bad = { ...base, assets: [{ nodeId: 11, balanceCents: 1234.5, hasNewFunds: false, updateSource: 'current' }] };
    const issues = validateRecorderPayload(bad);
    expect(issues.some((i) => i.field === 'assets[0].balanceCents')).toBe(true);
  });

  it('缺必填字段：debts 缺失', () => {
    const { debts, ...rest } = base as Record<string, unknown>;
    void debts;
    const issues = validateRecorderPayload(rest);
    expect(issues.some((i) => i.field === 'debts' && i.message.includes('必填'))).toBe(true);
  });

  it('月份格式非法被拒绝', () => {
    const issues = validateRecorderPayload({ ...base, month: '2026-13' });
    expect(issues.some((i) => i.field === 'month')).toBe(true);
  });

  it('updateSource 只允许 current/carried', () => {
    const bad = { ...base, assets: [{ nodeId: 11, balanceCents: 1, hasNewFunds: true, updateSource: 'manual' }] };
    expect(validateRecorderPayload(bad).some((i) => i.field === 'assets[0].updateSource')).toBe(true);
  });

  it('未知字段（additionalProperties=false）被拒绝', () => {
    const bad = { ...base, hijack: 'rm -rf' };
    expect(validateRecorderPayload(bad).some((i) => i.field === 'hijack')).toBe(true);
  });

  it('大额名称长度上限 50', () => {
    const bad = {
      ...base,
      largeItems: [{ direction: 'expense', catItemId: 9, name: 'x'.repeat(51), amountCents: 100000 }],
    };
    expect(validateRecorderPayload(bad).some((i) => i.field === 'largeItems[0].name')).toBe(true);
  });

  it('schema 文件本身可读取且金额字段声明为 integer', () => {
    const schema = loadRecorderSchema();
    const props = (schema.properties as Record<string, any>).assets.items.properties;
    expect(props.balanceCents.type).toBe('integer');
  });
});
