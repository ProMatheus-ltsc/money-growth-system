/**
 * 只读冒烟状态判定（COMP-003 / MAJ-2）：仅 2xx 与鉴权保护型 401/403 视为可达。
 * 404/405/429/5xx 一律视为失败，避免路由配错或多写路径被误判为通过。
 */
export function smokeStatusOk(status) {
  return (status >= 200 && status < 300) || status === 401 || status === 403;
}
