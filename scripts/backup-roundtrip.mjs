#!/usr/bin/env node
/**
 * 备份往返自测（本地离线，不需要 wrangler / 线上库）：
 *   迁移建表 → 造数据（含折旧/重估/或有负债/健康阈值 + 实物资产分类）→
 *   导出 payload → 校验 → 全量恢复 → 逐项核对（外键完整性 / 字段保真 / 扩展表条数）。
 *
 * 依赖：Node 22.5+ 的 `node:sqlite`（CI 用 Node 22，本机建议 Node 22+）。
 *
 * 两种运行方式：
 *   1) 直接用 esbuild JS API 打包（本机无沙箱限制时最省事）：
 *        node scripts/backup-roundtrip.mjs
 *   2) 先由 shell 打包、再把产物路径传进来（受限沙箱下 esbuild 的子进程管道会被拦，
 *      此时用 CLI 打包 + MGS_BACKUP_BUNDLE 指定即可）：
 *        npx esbuild backend/services/backupCore.ts --bundle --format=esm \
 *          --platform=node --outfile=/tmp/backupCore.mjs
 *        MGS_BACKUP_BUNDLE=/tmp/backupCore.mjs node scripts/backup-roundtrip.mjs
 *
 * 其它环境变量：MGS_BACKUP_ENTRY 指定被测源码（回归对照旧版本时用）。
 * 退出码：0 全部通过；1 有用例失败。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MGS_BACKUP_ENTRY
  ? path.resolve(process.env.MGS_BACKUP_ENTRY)
  : path.join(repoRoot, 'backend', 'services', 'backupCore.ts');
const prebuiltBundle = process.env.MGS_BACKUP_BUNDLE ? path.resolve(process.env.MGS_BACKUP_BUNDLE) : null;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name) {
  pass++;
  console.log(`  ✅ ${name}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name} — ${detail}`);
  console.log(`  ❌ ${name} — ${detail}`);
}
function check(name, cond, detail = '') {
  cond ? ok(name) : bad(name, detail);
}

// ---------------- D1 兼容层（node:sqlite 之上） ----------------
class Stmt {
  constructor(driver, sql, params = []) {
    this.driver = driver;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Stmt(this.driver, this.sql, params.map(norm));
  }
  _stmt() {
    return this.driver.db.prepare(this.sql);
  }
  async first(col) {
    const row = this._stmt().get(...this.params);
    if (!row) return null;
    return col ? row[col] : row;
  }
  async all() {
    const results = this._stmt().all(...this.params);
    return { success: true, results, meta: { changes: 0 } };
  }
  async run() {
    const r = this._stmt().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

class Db {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  /** D1 batch 语义：单事务内顺序执行，任一条失败整体回滚 */
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** node:sqlite 不接受 undefined / boolean，统一归一化 */
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// ---------------- 建库 ----------------
function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(repoRoot, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) sqlite.exec(readFileSync(path.join(dir, f), 'utf8'));
  return { sqlite, db: new Db(sqlite) };
}

// ---------------- 造数据 ----------------
async function seed(db) {
  const now = '2026-11-01T00:00:00Z';
  // 物理资产节点（迁移 0003 已建「实物资产（电子产品）」+ 手机/电脑/平板）
  const physical = await db
    .prepare("SELECT id, name FROM tree_nodes WHERE config_id = 1 AND asset_category = 'physical' ORDER BY id")
    .all();
  const phone = physical.results.find((n) => n.name === '手机') ?? physical.results[0];
  const cbNode = (await db.prepare("SELECT id FROM tree_nodes WHERE config_id = 1 AND name = '（待拆分）' ORDER BY id LIMIT 1").first())?.id;

  // 折旧（外键引用 tree_nodes）
  await db
    .prepare(
      `INSERT INTO asset_depreciation (node_id, config_id, depreciation_category, original_value, purchase_date,
       useful_life_months, salvage_rate, salvage_mode, market_salvage_value, created_at)
       VALUES (?, 1, 'electronics', 6999, '2025-06-01', 36, 0.2, 'rate', NULL, ?)`
    )
    .bind(phone.id, now)
    .run();

  // 重估（外键引用 tree_nodes）
  await db
    .prepare(
      `INSERT INTO asset_revaluations (node_id, revaluation_date, previous_value_cents, new_value_cents, change_cents,
       change_type, reason, appraiser, created_by, created_at)
       VALUES (?, '2026-10-31', 500000, 420000, -80000, 'depreciation', '二手行情下跌', '自查', NULL, ?)`
    )
    .bind(phone.id, now)
    .run();

  // 或有负债 / 健康阈值
  await db
    .prepare(
      `INSERT INTO contingent_liabilities (name, liability_type, estimated_amount_cents, probability, counterparty,
       start_date, expiry_date, description, status, created_by, created_at, updated_at)
       VALUES ('朋友贷款担保', 'guarantee', 3000000, 'possible', '张某', '2026-01-01', '2028-01-01', '连带担保', 'active', NULL, ?, ?)`
    )
    .bind(now, now)
    .run();
  await db.prepare("INSERT OR REPLACE INTO health_config (key, value, updated_at) VALUES ('savings_rate_min', '0.25', ?)").bind(now).run();

  // 负债
  await db
    .prepare(
      `INSERT INTO debts (name, debt_type, term, balance_cents, annual_rate, monthly_payment_cents, fixed_repayment, enabled, sort_order, created_at, updated_at)
       VALUES ('测试房贷', 'mortgage', 'long', 80000000, 0.045, 500000, 1, 1, 0, ?, ?)`
    )
    .bind(now, now)
    .run();
  const debt = await db.prepare("SELECT id FROM debts WHERE name = '测试房贷'").first();

  // 快照（2026-10）：末级资产 + 收支 + 大额明细
  const leaves = await db
    .prepare(
      `SELECT n.id FROM tree_nodes n WHERE n.config_id = 1 AND n.enabled = 1
       AND NOT EXISTS (SELECT 1 FROM tree_nodes c WHERE c.parent_id = n.id)`
    )
    .all();
  const snap = await db
    .prepare(
      `INSERT INTO monthly_snapshots (month, tree_config_id, cat_config_id, total_assets_cents, total_debt_cents,
       total_income_cents, total_expense_cents, created_at, updated_at, corrected_at)
       VALUES ('2026-10', 1, 1, 0, 0, 0, 0, ?, ?, NULL)`
    )
    .bind(now, now)
    .run();
  const snapshotId = snap.meta.last_row_id;
  let totalAssets = 0;
  for (const [i, leaf] of leaves.results.entries()) {
    const balance = 100000 + i * 1000;
    totalAssets += balance;
    await db
      .prepare('INSERT INTO snapshot_assets (snapshot_id, node_id, balance_cents, has_new_funds, update_source) VALUES (?, ?, ?, 0, ?)')
      .bind(snapshotId, leaf.id, balance, i === 0 ? 'current' : 'carried')
      .run();
  }
  const catItem = await db.prepare("SELECT id FROM cat_items WHERE config_id = 1 AND name = '工资'").first();
  await db.prepare('INSERT INTO snapshot_cat_amounts (snapshot_id, cat_item_id, amount_cents) VALUES (?, ?, 2000000)').bind(snapshotId, catItem.id).run();
  await db
    .prepare('INSERT INTO snapshot_large_items (snapshot_id, direction, cat_item_id, name, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(snapshotId, 'income', catItem.id, '年终奖', 80000, now)
    .run();
  await db
    .prepare('INSERT INTO snapshot_debts (snapshot_id, debt_id, balance_cents, repayment_cents) VALUES (?, ?, ?, ?)')
    .bind(snapshotId, debt.id, 80000000, 500000)
    .run();
  await db
    .prepare('UPDATE monthly_snapshots SET total_assets_cents = ?, total_debt_cents = ?, total_income_cents = ?, total_expense_cents = ? WHERE id = ?')
    .bind(totalAssets, 80000000, 2000000, 0, snapshotId)
    .run();

  // 资产重分类：把一个末级改成低流动性（验证 liquidity 保真）
  await db.prepare("UPDATE tree_nodes SET liquidity = 'low', asset_category = 'financial' WHERE id = ?").bind(cbNode ?? leaves.results[0].id).run();

  return { snapshotId, phoneId: phone.id, cbNodeId: cbNode ?? leaves.results[0].id };
}

// ---------------- 主流程 ----------------
async function main() {
  console.log(`\n[备份往返自测] entry=${path.relative(repoRoot, entry) || entry}\n`);
  const workDir = mkdtempSync(path.join(tmpdir(), 'mgs-restore-'));
  const bundlePath = prebuiltBundle ?? path.join(workDir, 'backupCore.mjs');
  try {
    if (!prebuiltBundle) {
      const { build } = await import('esbuild');
      await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: bundlePath,
        logLevel: 'silent',
      });
    }
    const mod = await import(pathToFileURL(bundlePath).href);
    const { buildExportPayload, validateBackupPayload, restoreFromPayload, BACKUP_SCHEMA_VERSION } = mod;

    const { sqlite, db } = createDb();
    const seeded = await seed(db);

    // ---- 1. 导出 ----
    console.log('① 导出');
    const payload = await buildExportPayload(db);
    check(`schemaVersion = ${BACKUP_SCHEMA_VERSION}`, payload.schemaVersion === BACKUP_SCHEMA_VERSION, `got ${payload.schemaVersion}`);
    const phoneNode = payload.treeConfigs[0].nodes.find((n) => n.name === '手机');
    check('节点含 assetCategory = physical', phoneNode?.assetCategory === 'physical', JSON.stringify(phoneNode));
    check('节点含 liquidity 字段', typeof phoneNode?.liquidity === 'string', JSON.stringify(phoneNode));
    check('折旧已导出', Array.isArray(payload.depreciations) && payload.depreciations.length === 1, `count=${payload.depreciations?.length}`);
    check('折旧按名称路径定位', payload.depreciations?.[0]?.nodeKey?.endsWith('手机') === true, String(payload.depreciations?.[0]?.nodeKey));
    check('重估已导出', (payload.revaluations?.length ?? 0) === 1, `count=${payload.revaluations?.length}`);
    check('或有负债已导出', (payload.contingentLiabilities?.length ?? 0) === 1, `count=${payload.contingentLiabilities?.length}`);
    check('健康阈值已导出', (payload.healthConfig?.length ?? 0) >= 5, `count=${payload.healthConfig?.length}`);

    // ---- 2. 校验器 ----
    console.log('② 校验');
    const errs = validateBackupPayload(JSON.parse(JSON.stringify(payload)));
    check('自身导出物通过校验', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
    const v1 = JSON.parse(JSON.stringify(payload));
    v1.schemaVersion = 1;
    for (const k of ['depreciations', 'revaluations', 'contingentLiabilities', 'healthConfig']) delete v1[k];
    for (const n of v1.treeConfigs[0].nodes) { delete n.assetCategory; delete n.liquidity; }
    check('v1 历史格式仍被接受', validateBackupPayload(v1).length === 0, JSON.stringify(validateBackupPayload(v1).slice(0, 3)));

    // ---- 3. 恢复（P0-1：删除序列必须先清扩展表，否则 FK 阻断） ----
    console.log('③ 恢复');
    let restored = null;
    try {
      restored = await restoreFromPayload(db, payload);
      ok('restoreFromPayload 未抛错（无外键阻断）');
    } catch (e) {
      bad('restoreFromPayload 未抛错（无外键阻断）', String(e?.message ?? e));
    }
    const fk = sqlite.prepare('PRAGMA foreign_key_check').all();
    check('PRAGMA foreign_key_check 为空', fk.length === 0, JSON.stringify(fk.slice(0, 3)));

    if (restored) {
      check('折旧已恢复 1 条', restored.counts.depreciations === 1, JSON.stringify(restored.counts));
      check('重估已恢复 1 条', restored.counts.revaluations === 1, JSON.stringify(restored.counts));
      check('或有负债已恢复 1 条', restored.counts.contingentLiabilities === 1, JSON.stringify(restored.counts));
      check('恢复过程无告警', restored.warnings.length === 0, restored.warnings.join(' | '));

      // 字段保真：assetCategory / liquidity
      const phoneAfter = sqlite
        .prepare("SELECT asset_category, liquidity FROM tree_nodes WHERE name = '手机' AND config_id = (SELECT id FROM tree_configs WHERE version = 1)")
        .get();
      check('恢复后 手机 assetCategory=physical（未退化为 financial）', phoneAfter?.asset_category === 'physical', JSON.stringify(phoneAfter));
      const lowLiq = sqlite.prepare("SELECT liquidity FROM tree_nodes WHERE id = (SELECT MAX(id) FROM tree_nodes WHERE liquidity = 'low')").get();
      check('恢复后 liquidity=low 保留', lowLiq?.liquidity === 'low', JSON.stringify(lowLiq));

      // 外键指向的新 node_id 必须真实存在
      const dep = sqlite.prepare('SELECT node_id, config_id FROM asset_depreciation').get();
      const depNode = sqlite.prepare('SELECT name FROM tree_nodes WHERE id = ?').get(dep.node_id);
      check('折旧指向的 node_id 有效', depNode?.name === '手机', JSON.stringify({ dep, depNode }));
      check('折旧配置版本一致', dep.config_id === sqlite.prepare("SELECT id FROM tree_configs WHERE version = 1").get().id, '');

      // 快照勾稽未被破坏
      const snap = sqlite.prepare("SELECT total_assets_cents FROM monthly_snapshots WHERE month = '2026-10'").get();
      const sumAssets = sqlite
        .prepare(
          `SELECT COALESCE(SUM(sa.balance_cents), 0) AS s FROM snapshot_assets sa
           JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id WHERE ms.month = '2026-10'`
        )
        .get();
      check('恢复后总资产 = 明细 SUM', snap.total_assets_cents === sumAssets.s, `${snap.total_assets_cents} vs ${sumAssets.s}`);
      check('健康阈值 savings_rate_min 保持 0.25', sqlite.prepare("SELECT value FROM health_config WHERE key = 'savings_rate_min'").get()?.value === '0.25', '');
    }

    // ---- 4. v1 备份恢复（降级路径） ----
    console.log('④ v1 历史备份恢复');
    try {
      const r1 = await restoreFromPayload(db, v1);
      ok('v1 备份可恢复（不因缺扩展表而失败）');
      check('v1 恢复给出折旧丢失告警', r1.warnings.some((w) => w.includes('折旧')), JSON.stringify(r1.warnings));
      const fk2 = sqlite.prepare('PRAGMA foreign_key_check').all();
      check('v1 恢复后外键仍完整', fk2.length === 0, JSON.stringify(fk2.slice(0, 3)));
      const cat = sqlite.prepare("SELECT asset_category FROM tree_nodes WHERE name = '手机'").get();
      check('v1 恢复后缺失字段回退 financial（文档化的降级行为）', cat?.asset_category === 'financial', JSON.stringify(cat));
      check('v1 恢复后健康阈值仍齐备', (sqlite.prepare('SELECT COUNT(*) AS c FROM health_config').get()?.c ?? 0) >= 5, '');
      check(
        'v1 恢复不覆盖用户自定义健康阈值',
        sqlite.prepare("SELECT value FROM health_config WHERE key = 'savings_rate_min'").get()?.value === '0.25',
        String(sqlite.prepare("SELECT value FROM health_config WHERE key = 'savings_rate_min'").get()?.value)
      );
    } catch (e) {
      bad('v1 备份可恢复（不因缺扩展表而失败）', String(e?.message ?? e));
    }

    sqlite.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`\n========================================`);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log(`失败项：\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('备份往返自测全部通过 ✅\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
