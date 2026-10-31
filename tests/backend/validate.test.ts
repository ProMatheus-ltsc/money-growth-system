/**
 * 通用字段校验原语回归（F-01/F-02 表单边界）：id/字符串/布尔/枚举/整数与错误构造器。
 */
import { describe, it, expect } from 'vitest';
import { idParam, strField, boolField, enumField, intField, USERNAME_RE } from '../../backend/lib/validate.ts';
import { ApiError, invalidParam, unauthorized, authFailed, lockedOut, forbidden, notFound, conflict, historyLocked } from '../../backend/lib/errors.ts';

describe('validate 原语', () => {
  it('idParam 非法抛 INVALID_PARAM 400', () => {
    try {
      idParam('0');
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('INVALID_PARAM');
      expect((e as ApiError).status).toBe(400);
    }
    expect(idParam('42')).toBe(42);
  });

  it('strField 必填/长度/正则', () => {
    const errors: { field: string; message: string }[] = [];
    expect(strField(undefined, 'name', errors)).toBeNull();
    expect(errors[0].message).toContain('必填');
    expect(strField('   ', 'name', errors)).toBeNull();
    expect(strField('abcdef', 'name', errors, { max: 3 })).toBeNull();
    expect(strField('abc', 'name', errors, { pattern: USERNAME_RE, patternMsg: '格式非法' })).toBe('abc');
    expect(strField('a b', 'name', errors, { pattern: USERNAME_RE, patternMsg: '格式非法' })).toBeNull();
    expect(strField(undefined, 'opt', errors, { required: false })).toBeNull();
  });

  it('boolField 兜底与类型错误', () => {
    const errors: { field: string; message: string }[] = [];
    expect(boolField(undefined, 'flag', errors, true)).toBe(true);
    expect(boolField('yes', 'flag', errors, false)).toBe(false);
    expect(errors[0].message).toContain('布尔');
  });

  it('enumField 只接受白名单', () => {
    const errors: { field: string; message: string }[] = [];
    expect(enumField('income', 'direction', errors, ['income', 'expense'] as const)).toBe('income');
    expect(enumField('other', 'direction', errors, ['income', 'expense'] as const)).toBeNull();
    expect(errors[0].message).toContain('income/expense');
  });

  it('intField 整数与下限', () => {
    const errors: { field: string; message: string }[] = [];
    expect(intField(3, 'n', errors)).toBe(3);
    expect(intField(1.5, 'n', errors)).toBeNull();
    expect(intField(0, 'n', errors, { min: 1 })).toBeNull();
  });
});

describe('errors 构造器', () => {
  it('各错误码与状态映射', () => {
    expect((invalidParam('x') as ApiError).status).toBe(400);
    expect((unauthorized() as ApiError).code).toBe('UNAUTHORIZED');
    expect((authFailed() as ApiError).status).toBe(401);
    expect((lockedOut() as ApiError).status).toBe(423);
    expect((forbidden() as ApiError).status).toBe(403);
    expect((notFound('m') as ApiError).status).toBe(404);
    expect((conflict('c') as ApiError).code).toBe('CONFLICT');
    expect((historyLocked() as ApiError).code).toBe('HISTORY_LOCKED');
  });

  it('ApiError 携带 details', () => {
    const err = invalidParam('bad', [{ field: 'a', message: 'b' }]);
    expect(err.details).toEqual([{ field: 'a', message: 'b' }]);
  });
});
