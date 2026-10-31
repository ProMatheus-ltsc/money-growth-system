# 待确认清单（低置信 / 缺失字段）

> 模板来源：money-growth-recorder（COMP-002）。以下条目**未入库**，需用户确认后重新提交。凭据字段只允许掩码格式。

| # | 字段 | 原因 | 截图区域 | 建议补充 |
|---|------|------|----------|----------|
| {{index}} | {{field}} | {{reason}} | {{screenshotRegion}} | {{hint}} |

> 字段与 `config/recorder.schema.json` 的 `pending[]` 对齐：仅含 `field` / `reason` / `screenshotRegion`，截图文件名请写进 `screenshotRegion`（例如 `bank-2026-10.png#余额区`）。

## 常见原因码

- `low_confidence`：识别置信度 < 0.95
- `missing_field`：关键字段在截图中缺失
- `fx_unavailable`：主备汇率源均不可用（E_FX_UNAVAILABLE），禁止用陈旧值
- `config_mismatch`：资产树/分类配置 id 无法对应
- `window_exceeded`：目标月超出 20 个月纠错窗口（E_WINDOW_EXCEEDED）

## 用户确认后回填格式

```json
{
  "field": "<原字段路径>",
  "confirmedValue": "<人工确认后的值>",
  "confirmedBy": "user",
  "action": "requeue"
}
```

确认后 Agent 用回填值重组载荷（金额转人民币分整数），重新计算幂等键并提交。
