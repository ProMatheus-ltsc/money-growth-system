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
├── scripts/               # 冒烟脚本（chart-smoke / ssr-smoke / smoke-online）
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

## 文档索引

| 文档 | 说明 |
|------|------|
| [03-prd](https://github.com/ProMatheus-ltsc/money-growth-system/blob/main/../project/output/03-prd.md) 等契约文档 | 需求（PRD）、技术方案、接口契约、开发计划、代码审查、测试用例、测试报告、部署手册（见项目 output/ 目录，本仓库不含） |

> 契约类文档（PRD / 技术方案 / 接口契约 / 测试用例等）存放在交付平台的 `project/projects/PRJ-2026-001/output/` 目录，不在本仓库内。

## 相关

- 公共包：https://github.com/ProMatheus-ltsc/shared-core.git（file: 依赖，消费方适配层在 `src/adapters/shared/`）
- 接入模式参考：https://github.com/ProMatheus-ltsc/root-cause-analysis.git
