---
name: money-growth-recorder
description: 从财务截图（记账 App/银行/证券）提取月度快照数据，汇率换算后录入 money-growth 网站并产出确认清单。TRIGGER when 用户提供财务截图并要求录入某月账目，或要求读取/比对网站快照数据时使用。
---

# money-growth 截图记账

> 所有 API 调用只经由 MCP 工具面（`config/money-growth-mcp.json` 注册的 `money-growth` server）。禁止用 curl/浏览器直接写网站；禁止在任何产物中写入凭据真实值。

## 前置检查

1. MCP server 已注册（Qoder MCP 设置中出现 `money-growth`）。未注册时按 `config/money-growth-mcp.json` 提示注册路径，不得绕过。
2. 仓库外凭据文件存在（默认 `~/secrets/money-growth.env`，或环境变量 `MGS_ENV` 指向的路径），含 `MGS_URL`、`MGS_INVITE_CODE`、`MGS_USERNAME`、`MGS_PASSWORD` 四个变量（只核对变量名存在，禁止 cat 打印值）。
3. 调用 `mg_verify_auth` 探活；返回 `E_AUTH_LOCKED` 时立即停止并报告用户（锁 15 分钟），不得重试。

## 流程

### 1. 截图接收与提取
- 逐张识别来源类型：`ledger_app`（记账 App 月报）/ `bank`（银行余额/流水）/ `securities`（证券资产页）。
- 提取字段：目标月份（YYYY-MM）、资产叶子节点余额、收支二级分类金额、大额明细（direction/分类/名称/金额）、负债余额与当月还款。
- 每个字段标注 `confidence`（0~1）与 `screenshotRef`（文件名+区域）。
- **confidence < 0.95 或字段缺失 → 进 `pending[]` 待确认，绝不猜测入库。**

### 2. 汇率换算（非人民币条目）
- 对 HKD/SGD/USD 金额调用 `mg_lookup_rate`（base=币种），取回 `{rate, source, fetchedAt}`。
- 金额统一换算为**人民币分整数**（`amountCents = round(原币分 × rate)`）。
- 工具返回 `E_FX_UNAVAILABLE` → 该条目整体转 `pending[]`，禁止用陈旧汇率替代。

### 3. 载荷组装与校验
- 按 `config/recorder.schema.json` 组装录入载荷（金额全部分整数），`pending[]` 随载荷保留但不入库。
- 配置 id 用 `mg_get_snapshot`/站点当前配置读取的 `treeConfigId`、`catConfigId`；节点/分类 id 无法对应 → 待确认。

### 4. 写路径路由
- 调用 `mg_check_lock_window {month}` 得到 `writePath ∈ save|correct|rejected`：
  - `save` → `mg_save_snapshot {month, payload, idempotencyKey}`
  - `correct` → `mg_correct_snapshot {month, patch, idempotencyKey}`（仅最近 20 个月窗口）
  - `rejected`（未来月/超窗锁定月）→ 零写请求，向用户说明原因。
- `idempotencyKey` = sha256(截图内容哈希|月份|载荷指纹)；同一截图重复提交命中 `E_DUP_IDEMPOTENT` 时只做读回比对，不重复写。

### 5. 读回校验与确认清单
- 写入成功后调用 `mg_get_snapshot` 读回，逐项比对金额（分整数精确相等）。
- 按 `templates/mg-checklist.html` 字段契约生成确认清单：`month`、`items[]`（category/originalAmount+currency/rate/rateSource/rateFetchedAt/cnyYuan/storedCents/screenshotRef/writePath/status）、`pending[]`、`failures[]`。
- 部分失败时逐条标注失败项与原因，不得整体省略。

## 约束（红线）

- 凭据不进代码、产物、日志、提交；错误信息中账户一律掩码（前 3 位+***）。
- 不删除、不覆盖既有快照；历史锁定月只走 correct 端点。
- 超 20 个月窗口的历史修改一律拒绝。
- 单工具调用超时 20s；写操作超时后标记 PARTIAL 上报，不静默重试。

## 自检命令

```bash
node --experimental-strip-types -e "import('./scripts/mcp/api-client.ts').then(m=>console.log(typeof m.MgsClient))"
npm test
```

## 返回结构（批处理结束时输出）

```json
{
  "ok": true,
  "month": "YYYY-MM",
  "writePath": "save|correct|rejected",
  "idempotencyKey": "<sha256>",
  "written": 0,
  "pending": [],
  "failures": [],
  "errors": []
}
```
