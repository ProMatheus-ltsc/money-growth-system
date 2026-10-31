/**
 * 快照写路径路由与纠错窗口回归（REQ-004 / F-004）。
 * 覆盖：未来月拒绝、当月 save、历史锁定月按窗口分流 correct / reject。
 */
import { describe, it, expect } from 'vitest';
import { decideWritePath, withinCorrectWindow } from '../../scripts/mcp/api-client.ts';
import { addMonths } from '../../backend/lib/month.ts';

const CUR = '2026-10';

describe('decideWritePath', () => {
  it('未来月 → reject', () => {
    expect(decideWritePath('2026-11', CUR, false)).toBe('reject');
    expect(decideWritePath('2026-12', CUR, true)).toBe('reject');
  });

  it('非法月份格式 → reject', () => {
    expect(decideWritePath('2026-13', CUR, false)).toBe('reject');
    expect(decideWritePath('abc', CUR, false)).toBe('reject');
  });

  it('当月 → save（无论历史是否存在）', () => {
    expect(decideWritePath(CUR, CUR, false)).toBe('save');
    expect(decideWritePath(CUR, CUR, true)).toBe('save');
  });

  it('历史月无快照 → save；有快照 → correct（窗口内）', () => {
    expect(decideWritePath('2026-09', CUR, false)).toBe('save');
    expect(decideWritePath('2026-09', CUR, true)).toBe('correct');
  });

  it('超出 20 个月窗口的锁定月 → reject', () => {
    const tooOld = addMonths(CUR, -25);
    expect(decideWritePath(tooOld, CUR, true)).toBe('reject');
  });

  it('窗口边界：第 19 个月内可纠错，第 20 个月起拒绝', () => {
    expect(decideWritePath(addMonths(CUR, -19), CUR, true)).toBe('correct');
    expect(decideWritePath(addMonths(CUR, -20), CUR, true)).toBe('reject');
  });
});

describe('withinCorrectWindow', () => {
  it('当月不算窗口内（当月直接 save）', () => {
    expect(withinCorrectWindow(CUR, CUR)).toBe(false);
  });
  it('最近一个历史月在窗口内', () => {
    expect(withinCorrectWindow(addMonths(CUR, -1), CUR)).toBe(true);
  });
  it('窗口首尾边界', () => {
    expect(withinCorrectWindow(addMonths(CUR, -19), CUR)).toBe(true);
    expect(withinCorrectWindow(addMonths(CUR, -20), CUR)).toBe(false);
  });
  it('未来月不在纠错窗口', () => {
    expect(withinCorrectWindow('2026-11', CUR)).toBe(false);
  });
});
