/**
 * 金额口径回归保护（REQ-007）：元↔分转换与两位小数校验。
 * 直接复用站点 backend/lib/money.ts，锁定录入模型「分整数」边界。
 */
import { describe, it, expect } from 'vitest';
import { yuanToCents, centsToYuan } from '../../backend/lib/money.ts';

describe('yuanToCents / centsToYuan', () => {
  it('正常元值转分整数', () => {
    const errs: { field: string; message: string }[] = [];
    expect(yuanToCents(12.34, 'balance', errs)).toBe(1234);
    expect(errs).toHaveLength(0);
  });

  it('浮点安全：0.07 转 7 分', () => {
    const errs: { field: string; message: string }[] = [];
    expect(yuanToCents(0.07, 'a', errs)).toBe(7);
  });

  it('超过两位小数拒绝', () => {
    const errs: { field: string; message: string }[] = [];
    expect(yuanToCents(1.005, 'a', errs)).toBeNull();
    expect(errs[0].message).toContain('两位小数');
  });

  it('负数默认拒绝，min:-Infinity 放行', () => {
    const errs: { field: string; message: string }[] = [];
    expect(yuanToCents(-1, 'a', errs)).toBeNull();
    const errs2: { field: string; message: string }[] = [];
    expect(yuanToCents(-1, 'gain', errs2, { min: -Infinity })).toBe(-100);
  });

  it('非数字/空值拒绝', () => {
    const errs: { field: string; message: string }[] = [];
    expect(yuanToCents('12', 'a', errs)).toBeNull();
    expect(yuanToCents(NaN, 'a', errs)).toBeNull();
    expect(yuanToCents(null, 'a', errs)).toBeNull();
  });

  it('centsToYuan 逆向一致', () => {
    expect(centsToYuan(1234)).toBe(12.34);
  });
});
