/**
 * 统一错误类型与构造器（错误码与 HTTP 状态映射见 05 §1.3）。
 */
/** 字段级错误详情（用于表单校验失败时返回逐字段提示） */
export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * 统一业务错误类：由路由层 throw，被 app.onError 捕获后转为标准 JSON 响应。
 * code 字段用于前端精确匹配错误类型（如 AUTH_FAILED、LOCKED_OUT 等）。
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: ErrorDetail[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const invalidParam = (message: string, details?: ErrorDetail[]) =>
  new ApiError('INVALID_PARAM', 400, message, details);

export const unauthorized = (message = '会话不存在或已过期，请重新登录') =>
  new ApiError('UNAUTHORIZED', 401, message);

export const authFailed = () => new ApiError('AUTH_FAILED', 401, '用户名或密码错误');

export const lockedOut = () =>
  new ApiError('LOCKED_OUT', 423, '连续失败次数过多，账号已锁定，请 15 分钟后重试');

export const forbidden = () => new ApiError('FORBIDDEN', 403, '权限不足');

export const notFound = (message: string) => new ApiError('NOT_FOUND', 404, message);

export const conflict = (message: string) => new ApiError('CONFLICT', 409, message);

export const historyLocked = () =>
  new ApiError('HISTORY_LOCKED', 409, '历史月份已锁定，请通过纠错流程（二次确认）修改');
