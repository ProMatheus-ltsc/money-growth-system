/**
 * 冒烟可达性判定回归（S7 MAJOR：404/429 不得被当作通过）。
 */
import { describe, it, expect } from 'vitest';
import { smokeStatusOk } from '../../scripts/autofix/smoke-policy.mjs';

describe('smokeStatusOk', () => {
  it('2xx 与鉴权保护型 401/403 视为可达', () => {
    for (const s of [200, 204, 401, 403]) expect(smokeStatusOk(s)).toBe(true);
  });
  it('404/405/429/5xx 与网络失败码一律失败', () => {
    for (const s of [0, 301, 404, 405, 429, 500, 502, 503]) expect(smokeStatusOk(s)).toBe(false);
  });
});
