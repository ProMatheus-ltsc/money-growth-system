# money-growth-system（资产增长系统）

家庭资产增长记录工具 —— 记录每一笔，见证家庭财富成长。

- **线上地址**: https://money-growth-sys.pages.dev
- **仓库**: https://github.com/ProMatheus-ltsc/money-growth-system.git
- **技术栈**: Cloudflare Pages + Pages Functions + D1（SQLite）+ Vite + React 18 + TypeScript + Tailwind CSS + Hono + ECharts

## 功能总览

| 模块 | 说明 |
|------|------|
| 双角色账号 | 管理员（读写）+ 只读账号；登录前置邀请码门控；PBKDF2-SHA-256 口令 + 数据库令牌会话 |
| 月末资产快照 | 资产树（版本化）末级余额录入、新增资金标记、模块收益金额、勾稽汇总 |
| 收支分类 | 两级分类（版本化）、大额单笔（≥阈值）、月度收入/支出/结余 |
| 负债管理 | 房贷/车贷/信用卡等，固定/非固定还款 |
| 增长分析 | 实际收益率四态口径（自动/折算/留空/不折算）、预期增长线 |
| 报表 | 资产复盘（KPI/趋势/树图/桑基/收益对比/更新状态）+ 财务三张表（资产负债/收支/现金流）+ 近 12 月趋势 |
| 定期报告快照 | 季度/年度报告冻结 + 对比分析 |
| 历史纠错 | 历史月快照纠错（勾选确认 + 差异记录 + 操作人留痕） |
| AI 分析 | 四分区数据包导出（数据/提示词/结果格式/示例）+ 分析结果保存 |
| PDF 报告 | 月度/季度财务报告导出（无身份信息） |
| 扩展功能 | 实物资产折旧（多方法/残值率）、资产重估、或有负债、财务健康度、用户管理 |
| 备份 | 本地 JSON 全量导出 / 文件恢复（先校验后写入） |

## 金额处理约定

金额全链路三层分层，各层用各自最精确的工具，杜绝浮点误差：

| 层 | 位置 | 做法 |
|----|------|------|
| 校验（判格式） | `src/lib/validate.ts` | **字符串层正则精确判定**（零浮点运算）：余额/收支/负债为非负 `^\d+(\.\d{1,2})?$`；收益金额可正可负 `^-?\d+(\.\d{1,2})?$`；数字输入（快照回填等）用 `toFixed(2)` 往返判断 |
| 转换（边界） | `parseAmount` | 校验通过后 string → number（兼容千分位逗号）；空 / 单独的 `-` → null（当留空） |
| 权威存储与运算 | `backend/lib/money.ts` | API 层「元」（≤2 位小数）、存储「分」（INTEGER）；`yuanToCents` / `centsToYuan` 转换只发生在服务端边界，运算全程整数 |

要点：

- 「小数位数」是字符串属性，正则判定天然精确——`1.1 × 100 = 110.00000000000001` 这类浮点误差**不影响校验**（勿用 `Math.round(n*100) === n*100` 严格相等判断两位小数，会误伤合法值）
- 前端合计仅为展示用途（`fmtMoney` 格式化两位小数）；报表与勾稽以服务端整数分结算为准
- 千分位逗号分隔符允许（如 `1,234.56`）；金额字段留空语义：余额必填、收益金额可留空（报表标注「留空」）

## 目录结构

```
.
├── public/                # 静态资源（favicon 等）
├── src/                   # 前端（React + TS）
│   ├── adapters/
│   │   ├── auth/          # REST 认证驱动（服务端账号体系）
│   │   └── shared/        # @shared/core 消费方适配层（上游不动）
│   ├── components/        # 页面级组件
│   ├── context/           # 全局状态（草稿/UI）
│   ├── lib/               # API 客户端、格式化、校验
│   └── pages/             # 14 个页面
├── backend/               # 后端源码（Hono，被 functions 引用）
│   ├── routes/            # 各资源路由（auth/tree/snapshots/reports/debts/backups/ai/pdf/折旧/健康…）
│   ├── services/          # 业务逻辑（快照写入/报表聚合/备份核心/AI 文本…）
│   ├── middleware/        # 鉴权中间件
│   └── lib/               # 错误/响应/校验/密码工具
├── functions/api/         # Pages Functions 入口（catch-all → Hono）
├── migrations/            # D1 迁移（0001_init + 0002_seed + 0003~0007 扩展）
├── scripts/               # 冒烟/自测脚本（chart-smoke / ssr-smoke / smoke-online / backup-roundtrip / snapshot-debt-sync）
├── .github/workflows/     # GitHub Actions 自动部署
├── index.html
├── wrangler.toml          # Cloudflare 配置（D1 绑定）
└── vite.config.ts
```

## 快速开始（本地开发）

依赖说明：`@shared/core` 以 **file: 依赖**接入（参考 root-cause-analysis 模式），须在项目**父目录**存在 shared-core 仓库：

```bash
# 1. 准备共享包（父目录，Windows 可用 junction 链接到你的 shared-core 副本）
git clone https://github.com/ProMatheus-ltsc/shared-core.git ../shared-core

# 2. 安装依赖
npm install

# 3. 配置本地邀请码（登录门控，不入库）
#    复制 .env.example 为 .dev.vars 并填写 INVITE_CODE=你的邀请码

# 4. 本地 D1 迁移
npx wrangler d1 migrations apply fam-asset-db --local

# 5. 启动（前端 + Functions 本地模拟）
npm run dev            # vite dev（/api 代理到 8788）
npx wrangler pages dev dist --port 8788 --d1 DB=fam-asset-db   # 或 npm run pages:dev

# 6. 构建与检查
npm run typecheck && npm run build
```

> Windows 注意：wrangler 本地 workerd 在部分环境会崩溃（access violation），此时本地 API 模拟不可用——线上部署不受影响（GitHub Actions 构建）。

## 部署（CI/CD 全自动）

push 到 `main` 即触发 GitHub Actions（`.github/workflows/deploy.yml`）：clone shared-core → 安装依赖 → typecheck → build → D1 迁移 → Pages 部署。

一次性配置（首次）：
1. GitHub 仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
2. Cloudflare 控制台创建 D1 数据库 `fam-asset-db`，database_id 回填 `wrangler.toml`
3. 部署后设置登录邀请码：Workers & Pages → money-growth-system → Settings → Variables and Secrets → `INVITE_CODE`

详细手册见 `docs/10-deploy-manual.md`。

## 备份说明

V1.4 起**仅本地备份**（云端 R2 备份已下线）：备份页「下载全量备份」导出 JSON 留档、「从文件恢复」先校验后写入（非法文件不影响现有数据）。请定期下载留档。

备份格式版本（`schemaVersion`）：

| 版本 | 内容 | 恢复行为 |
|------|------|----------|
| v2（当前，2026-11 起） | 资产树/分类配置（含 `assetCategory`/`liquidity`）、月度快照、负债、报告快照、AI 记录、**折旧参数、重估记录、或有负债、健康阈值** | 全量覆盖上述所有表 |
| v1（历史文件） | 不含资产分类/流动性字段，且不含折旧/重估/或有负债/健康阈值 | 兼容恢复：缺失字段回退默认值；折旧与重估因无数据只能清空（返回 `warnings` 明确提示需重新录入）；或有负债与健康阈值保留原值/回填缺省值 |

恢复的删除顺序严格遵循外键依赖：`asset_revaluations` → `asset_depreciation` → 快照明细 → `monthly_snapshots` → 配置与主档 → `tree_nodes`/`tree_configs`。缺这一步会因 D1 强制外键而整批回滚（历史 P0 缺陷，已修复）。

回归自测（本地离线，不需要 wrangler）：

```bash
# 备份导出 → 恢复往返（外键完整性 / 字段保真 / 扩展表条数 / v1 降级路径）
npx esbuild backend/services/backupCore.ts --bundle --format=esm --platform=node --outfile=/tmp/backupCore.mjs
MGS_BACKUP_BUNDLE=/tmp/backupCore.mjs node scripts/backup-roundtrip.mjs

# 负债主档同步（最新月同步 / 历史纠错不回写）
npx esbuild backend/services/snapshotWriter.ts --bundle --format=esm --platform=node --outfile=/tmp/snapshotWriter.mjs
MGS_SNAPSHOT_BUNDLE=/tmp/snapshotWriter.mjs node scripts/snapshot-debt-sync.mjs
```

## 运维约定

- **负债主档**：`debts.balance_cents` 只由「最新月」的快照写入推进；历史纠错/补录不回写主档（避免负债管理页与后续默认值被旧值污染）。返回值 `debtMasterSynced` 标明本次是否同步。
- **认证数据清理**：过期 `sessions` / `gate_tokens`、冷却期外的 `ip_rate_limit`、180 天前的 `login_audit_log` 由 `/api/auth/verify-invite` 惰性清理（Pages 无 scheduled handler）；也可手动 `GET /api/auth/maintenance`（预览）/ `POST /api/auth/maintenance`（执行，仅 admin）。
- **审计脱敏**：邀请码输错只记录「长度 + SHA-256 前 8 位」，不再明文入库。
- **资产树版本**：新版本生效月不得早于上一版本（单调性校验），折旧配置按「节点全路径」而非裸名迁移。


## 文档索引

| 文档 | 说明 |
|------|------|
| [03-prd](https://github.com/ProMatheus-ltsc/money-growth-system/blob/main/../project/output/03-prd.md) 等契约文档 | 需求（PRD）、技术方案、接口契约、开发计划、代码审查、测试用例、测试报告、部署手册（见项目 output/ 目录，本仓库不含） |

> 契约类文档（PRD / 技术方案 / 接口契约 / 测试用例等）存放在交付平台的 `project/projects/PRJ-2026-001/output/` 目录，不在本仓库内。

## 相关

- 公共包：https://github.com/ProMatheus-ltsc/shared-core.git（file: 依赖，消费方适配层在 `src/adapters/shared/`）
- 接入模式参考：https://github.com/ProMatheus-ltsc/root-cause-analysis.git
