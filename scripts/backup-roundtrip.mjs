#!/usr/bin/env node
/**
 * 备份往返自测（离线，不需要 wrangler / 线上库）：
 *   迁移建表 → 造数据（**含同名同级节点** + 折旧/重估/或有负债/健康阈值 + 实物分类）
 *   → 导出 → 校验 → 恢复 → 核对（外键完整性 / 引用不塌陷 / 字段保真 / 原子性）。
 *
 * 重点覆盖历史上真实踩到的两类缺陷：
 *   1) 恢复删除序列缺 asset_revaluations / asset_depreciation → 外键阻断，恢复 100% 失败；
 *   2) 节点引用用「名称路径」→ 同名同级节点塌成一个 key → 撞 UNIQUE(snapshot_id,node_id)
 *      → 恢复中途失败，留下「配置已重建、明细为空」的半恢复状态。
 *
 * 依赖：Node 22.5+ 的 `node:sqlite`。
 * 用法：
 *   node scripts/backup-roundtrip.mjs                        # 直接用 esbuild JS API 打包
 *   MGS_BACKUP_BUNDLE=/tmp/backupCore.mjs node scripts/backup-roundtrip.mjs   # 用外部预打包产物
 *   MGS_BACKUP_ENTRY=path/to/old/backupCore.ts node ...      # 回归对照旧版本
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
function ok(name) { pass++; console.log(`  ✅ ${name}`); }
function bad(name, detail) { fail++; failures.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
function check(name, cond, detail = '') { cond ? ok(name) : bad(name, detail); }

// ---------------- D1 兼容层 ----------------
class Stmt {
  constructor(driver, sql, params = []) { this.driver = driver; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.driver, this.sql, params.map(norm)); }
  async first(col) {
    const row = this.driver.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return col ? row[col] : row;
  }
  async all() {
    return { success: true, results: this.driver.db.prepare(this.sql).all(...this.params), meta: { changes: 0 } };
  }
  async run() {
    const r = this.driver.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

class Db {
  constructor(sqlite) { this.db = sqlite; this.batchCalls = 0; this.stmtCounts = []; }
  prepare(sql) { return new Stmt(this, sql); }
  /** D1 batch 语义：单事务内顺序执行，任一条失败整体回滚 */
  async batch(stmts) {
    this.batchCalls++;
    this.stmtCounts.push(stmts.length);
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

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(repoRoot, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(path.join(dir, f), 'utf8'));
  }
  return { sqlite, db: new Db(sqlite) };
}

/** 同名同级节点的名称（模块级：seed 与断言共用） */
const DUP_NAME = '小李纳指100';

/**
 * 造数据。关键：在「实物资产（电子产品）」下放两个同名末级「小李纳指100」，
 * 复刻真实库里「两个账户下都有同名末级」的结构（迁移 0003 自带的『手机』另行排除）。
 */
async function seed(db) {
  const now = '2026-11-01T00:00:00Z';
  const physical = (await db.prepare("SELECT id FROM tree_nodes WHERE config_id = 1 AND name = '实物资产（电子产品）'").first())?.id;

  // 同名同级：两个「小李纳指100」，分别挂在两个子账户下
  // 注意：真实库里它们的父节点不同（支付宝 / 招商证券场内），这里用 identity_info 区分个体。
  await db.prepare(
    `INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order,
     identity_info, is_placeholder, asset_category, liquidity, created_at)
     VALUES (1, ?, ?, 'leaf', NULL, 'quarterly', 1, 20, '支付宝账户', 0, 'physical', 'low', ?)`
  ).bind(physical, DUP_NAME, now).run();
  await db.prepare(
    `INSERT INTO tree_nodes (config_id, parent_id, name, node_type, target_rate_annual, update_freq, enabled, sort_order,
     identity_info, is_placeholder, asset_category, liquidity, created_at)
     VALUES (1, ?, ?, 'leaf', NULL, 'quarterly', 1, 21, '招商证券场内', 0, 'physical', 'low', ?)`
  ).bind(physical, DUP_NAME, now).run();

  const phones = await db.prepare('SELECT id, identity_info FROM tree_nodes WHERE config_id = 1 AND name = ? ORDER BY sort_order')
    .bind(DUP_NAME).all();
  const [phoneA, phoneB] = phones.results;

  // 折旧挂在其中一个同名节点上（外键 → tree_nodes）
  await db.prepare(
    `INSERT INTO asset_depreciation (node_id, config_id, depreciation_category, original_value, purchase_date,
     useful_life_months, salvage_rate, salvage_mode, market_salvage_value, created_at)
     VALUES (?, 1, 'electronics', 6999, '2025-06-01', 36, 0.2, 'rate', NULL, ?)`
  ).bind(phoneA.id, now).run();

  // 重估挂在另一个同名节点上
  await db.prepare(
    `INSERT INTO asset_revaluations (node_id, revaluation_date, previous_value_cents, new_value_cents, change_cents,
     change_type, reason, appraiser, created_by, created_at)
     VALUES (?, '2026-10-31', 500000, 420000, -80000, 'depreciation', '二手行情下跌', '自查', NULL, ?)`
  ).bind(phoneB.id, now).run();

  await db.prepare(
    `INSERT INTO contingent_liabilities (name, liability_type, estimated_amount_cents, probability, counterparty,
     start_date, expiry_date, description, status, created_by, created_at, updated_at)
     VALUES ('朋友贷款担保', 'guarantee', 3000000, 'possible', '张某', '2026-01-01', '2028-01-01', '连带担保', 'active', NULL, ?, ?)`
  ).bind(now, now).run();
  await db.prepare("INSERT OR REPLACE INTO health_config (key, value, updated_at) VALUES ('savings_rate_min', '0.25', ?)").bind(now).run();

  await db.prepare(
    `INSERT INTO debts (name, debt_type, term, balance_cents, annual_rate, monthly_payment_cents, fixed_repayment, enabled, sort_order, created_at, updated_at)
     VALUES ('测试房贷', 'mortgage', 'long', 80000000, 0.045, 500000, 1, 1, 0, ?, ?)`
  ).bind(now, now).run();
  const debt = await db.prepare("SELECT id FROM debts WHERE name = '测试房贷'").first();

  const leaves = await db.prepare(
    `SELECT n.id FROM tree_nodes n WHERE n.config_id = 1 AND n.enabled = 1
     AND NOT EXISTS (SELECT 1 FROM tree_nodes c WHERE c.parent_id = n.id)`
  ).all();

  const snap = await db.prepare(
    `INSERT INTO monthly_snapshots (month, tree_config_id, cat_config_id, total_assets_cents, total_debt_cents,
     total_income_cents, total_expense_cents, created_at, updated_at, corrected_at)
     VALUES ('2026-10', 1, 1, 0, 0, 0, 0, ?, ?, NULL)`
  ).bind(now, now).run();
  const snapshotId = Number(snap.meta.last_row_id);
  let totalAssets = 0;
  for (const [i, leaf] of leaves.results.entries()) {
    const balance = 100000 + i * 1000;
    totalAssets += balance;
    await db.prepare('INSERT INTO snapshot_assets (snapshot_id, node_id, balance_cents, has_new_funds, update_source) VALUES (?, ?, ?, 0, ?)')
      .bind(snapshotId, leaf.id, balance, i === 0 ? 'current' : 'carried').run();
  }
  const catItem = await db.prepare("SELECT id FROM cat_items WHERE config_id = 1 AND name = '工资'").first();
  await db.prepare('INSERT INTO snapshot_cat_amounts (snapshot_id, cat_item_id, amount_cents) VALUES (?, ?, 2000000)').bind(snapshotId, catItem.id).run();
  await db.prepare('INSERT INTO snapshot_large_items (snapshot_id, direction, cat_item_id, name, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(snapshotId, 'income', catItem.id, '年终奖', 80000, now).run();
  await db.prepare('INSERT INTO snapshot_debts (snapshot_id, debt_id, balance_cents, repayment_cents) VALUES (?, ?, ?, ?)')
    .bind(snapshotId, debt.id, 80000000, 500000).run();
  // 两条同名节点的余额互不相同：恢复后必须各自保持在原节点上
  const balA = 123400, balB = 567800;
  await db.prepare('UPDATE snapshot_assets SET balance_cents = ? WHERE snapshot_id = ? AND node_id = ?').bind(balA, snapshotId, phoneA.id).run();
  await db.prepare('UPDATE snapshot_assets SET balance_cents = ? WHERE snapshot_id = ? AND node_id = ?').bind(balB, snapshotId, phoneB.id).run();
  totalAssets += (balA + balB) - (100000 + leaves.results.findIndex((l) => l.id === phoneA.id) * 1000)
    - (100000 + leaves.results.findIndex((l) => l.id === phoneB.id) * 1000);
  await db.prepare('UPDATE monthly_snapshots SET total_assets_cents = ?, total_debt_cents = ?, total_income_cents = ? WHERE id = ?')
    .bind(
      (await db.prepare('SELECT COALESCE(SUM(balance_cents),0) AS s FROM snapshot_assets WHERE snapshot_id = ?').bind(snapshotId).first()).s,
      80000000, 2000000, snapshotId
    ).run();

  return { snapshotId, phoneA, phoneB, balA, balB, debtId: debt.id };
}

async function main() {
  console.log(`\n[备份往返自测] entry=${path.relative(repoRoot, entry) || entry}\n`);
  const workDir = mkdtempSync(path.join(tmpdir(), 'mgs-restore-'));
  const bundlePath = prebuiltBundle ?? path.join(workDir, 'backupCore.mjs');
  try {
    if (!prebuiltBundle) {
      const { build } = await import('esbuild');
      await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundlePath, logLevel: 'silent' });
    }
    const mod = await import(pathToFileURL(bundlePath).href);
    const { buildExportPayload, validateBackupPayload, restoreFromPayload, BACKUP_SCHEMA_VERSION } = mod;

    const { sqlite, db } = createDb();
    const seeded = await seed(db);

    // ---- 1. 导出 ----
    console.log('① 导出');
    const payload = await buildExportPayload(db);
    check(`schemaVersion = ${BACKUP_SCHEMA_VERSION}`, payload.schemaVersion === BACKUP_SCHEMA_VERSION, `got ${payload.schemaVersion}`);
    const nodes = payload.treeConfigs[0].nodes;
    const phoneNodes = nodes.filter((n) => n.name === DUP_NAME);
    check('两个同名节点都导出', phoneNodes.length === 2, `count=${phoneNodes.length}`);
    check('同名节点 ref 互不相同', phoneNodes[0]?.ref !== phoneNodes[1]?.ref, `${phoneNodes[0]?.ref} vs ${phoneNodes[1]?.ref}`);
    check('v3 节点带 assetCategory/liquidity',
      phoneNodes.every((n) => n.assetCategory === 'physical' && n.liquidity === 'low'),
      JSON.stringify(phoneNodes.map((n) => [n.assetCategory, n.liquidity])));
    const snapAssets = payload.snapshots[0].assets;
    const phoneAssets = snapAssets.filter((a) => a.nodeKey?.endsWith(DUP_NAME));
    check('快照内两条同名节点明细都导出', phoneAssets.length === 2, `count=${phoneAssets.length}`);
    check('两条明细 nodeRef 不同（不再塌成同一个 key）', new Set(phoneAssets.map((a) => a.nodeRef)).size === 2, JSON.stringify(phoneAssets.map((a) => a.nodeRef)));
    check('折旧已导出并带 nodeRef', payload.depreciations?.[0]?.nodeRef != null, JSON.stringify(payload.depreciations?.[0]));
    check('重估已导出并带 nodeRef', payload.revaluations?.[0]?.nodeRef != null, JSON.stringify(payload.revaluations?.[0]));

    // ---- 2. 校验 ----
    console.log('② 校验');
    check('自身导出物通过校验', validateBackupPayload(JSON.parse(JSON.stringify(payload))).length === 0,
      JSON.stringify(validateBackupPayload(JSON.parse(JSON.stringify(payload))).slice(0, 3)));

    // v2 旧格式 + 同名同级节点 → 必须被校验器拦下（不再放进恢复里炸 UNIQUE）
    const v2 = JSON.parse(JSON.stringify(payload));
    v2.schemaVersion = 2;
    for (const n of v2.treeConfigs[0].nodes) { delete n.ref; delete n.parentRef; delete n.assetCategory; delete n.liquidity; }
    for (const a of v2.snapshots[0].assets) delete a.nodeRef;
    for (const g of v2.snapshots[0].moduleGains ?? []) delete g.nodeRef;
    for (const d of v2.depreciations ?? []) delete d.nodeRef;
    for (const r of v2.revaluations ?? []) delete r.nodeRef;
    const v2Errors = validateBackupPayload(v2);
    check('v2 旧格式遇同名同级节点被校验器拒绝（不再中途炸 UNIQUE）',
      v2Errors.some((e) => String(e.message).includes('同路径重名')), JSON.stringify(v2Errors.map((e) => e.message).slice(0, 2)));

    // ---- 3. 恢复 ----
    console.log('③ 恢复（原子）');
    let restored = null;
    try {
      restored = await restoreFromPayload(db, payload);
      ok('restoreFromPayload 未抛错');
    } catch (e) {
      bad('restoreFromPayload 未抛错', String(e?.message ?? e));
    }
    const fk = sqlite.prepare('PRAGMA foreign_key_check').all();
    check('PRAGMA foreign_key_check 为空', fk.length === 0, JSON.stringify(fk.slice(0, 3)));
    check('恢复只用了 1 个 batch（单事务原子提交）', db.batchCalls === 1, `batchCalls=${db.batchCalls} sizes=${JSON.stringify(db.stmtCounts)}`);

    if (restored) {
      check('折旧/重估/或有负债各恢复 1 条',
        restored.counts.depreciations === 1 && restored.counts.revaluations === 1 && restored.counts.contingentLiabilities === 1,
        JSON.stringify(restored.counts));
      check('恢复过程无告警', restored.warnings.length === 0, restored.warnings.join(' | '));

      // 核心断言：两条同名节点各自独立存在，余额各自对得上
      const after = sqlite.prepare(
        `SELECT tn.id, tn.identity_info, sa.balance_cents FROM tree_nodes tn
         JOIN snapshot_assets sa ON sa.node_id = tn.id
         JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id
         WHERE tn.name = ? AND ms.month = '2026-10' ORDER BY tn.sort_order`
      ).all(DUP_NAME);
      check('恢复后仍有两个独立的同名节点', after.length === 2, JSON.stringify(after));
      check('两条余额未互相覆盖（123400 / 567800）',
        after.length === 2 && after[0].balance_cents === seeded.balA && after[1].balance_cents === seeded.balB,
        JSON.stringify(after.map((r) => r.balance_cents)));
      check('identity_info 保留（支付宝账户/招商证券场内）',
        after.map((r) => r.identity_info).join(',') === '支付宝账户,招商证券场内', JSON.stringify(after.map((r) => r.identity_info)));

      // 折旧/重估挂在正确的节点上（而不是都挂到第一个同名节点）
      const dep = sqlite.prepare('SELECT node_id FROM asset_depreciation').get();
      const rev = sqlite.prepare('SELECT node_id FROM asset_revaluations').get();
      const depNode = sqlite.prepare('SELECT identity_info FROM tree_nodes WHERE id = ?').get(dep.node_id);
      const revNode = sqlite.prepare('SELECT identity_info FROM tree_nodes WHERE id = ?').get(rev.node_id);
      check('折旧挂在「支付宝账户」', depNode?.identity_info === '支付宝账户', JSON.stringify(depNode));
      check('重估挂在「招商证券场内」', revNode?.identity_info === '招商证券场内', JSON.stringify(revNode));

      // 字段保真
      const phys = sqlite.prepare('SELECT asset_category, liquidity FROM tree_nodes WHERE name = ? LIMIT 1').get(DUP_NAME);
      check('assetCategory/liquidity 未退化', phys?.asset_category === 'physical' && phys?.liquidity === 'low', JSON.stringify(phys));

      // 勾稽
      const snap = sqlite.prepare("SELECT total_assets_cents FROM monthly_snapshots WHERE month = '2026-10'").get();
      const sum = sqlite.prepare(
        `SELECT COALESCE(SUM(sa.balance_cents),0) AS s FROM snapshot_assets sa
         JOIN monthly_snapshots ms ON ms.id = sa.snapshot_id WHERE ms.month = '2026-10'`
      ).get();
      check('总资产 = 明细 SUM', snap.total_assets_cents === sum.s, `${snap.total_assets_cents} vs ${sum.s}`);
      check('健康阈值 savings_rate_min 保持 0.25',
        sqlite.prepare("SELECT value FROM health_config WHERE key = 'savings_rate_min'").get()?.value === '0.25', '');
    }

    // ---- 4. 原子性：中途失败必须整体回滚 ----
    console.log('④ 原子性（失败不得留半恢复）');
    {
      const before = sqlite.prepare('SELECT COUNT(*) AS c FROM snapshot_assets').get().c;
      // 故意注入一个必然失败的 payload：第二次恢复时把「快照内节点」伪造成不存在
      // → 单 batch 内触发约束失败，验证回滚后数据与恢复前完全一致
      const broken = JSON.parse(JSON.stringify(payload));
      broken.snapshots[0].assets[0].updateSource = 'NOT_A_VALID_VALUE'; // CHECK 约束
      let threw = false;
      try { await restoreFromPayload(db, broken); } catch { threw = true; }
      check('非法数据导致恢复抛错', threw, '未抛错');
      const after = sqlite.prepare('SELECT COUNT(*) AS c FROM snapshot_assets').get().c;
      check('失败后明细行数不变（整体回滚，无半恢复）', before === after, `${before} → ${after}`);
      const cfgCount = sqlite.prepare('SELECT COUNT(*) AS c FROM tree_configs').get().c;
      check('失败后配置仍在（未被清空）', cfgCount >= 1, `tree_configs=${cfgCount}`);
      const fk2 = sqlite.prepare('PRAGMA foreign_key_check').all();
      check('失败后外键仍完整', fk2.length === 0, JSON.stringify(fk2.slice(0, 3)));
    }

    // ---- 5. v1 历史备份 ----
    console.log('⑤ v1 历史备份降级');
    {
      const v1 = JSON.parse(JSON.stringify(payload));
      v1.schemaVersion = 1;
      for (const k of ['depreciations', 'revaluations', 'contingentLiabilities', 'healthConfig']) delete v1[k];
      for (const n of v1.treeConfigs[0].nodes) { delete n.ref; delete n.parentRef; delete n.assetCategory; delete n.liquidity; }
      for (const a of v1.snapshots[0].assets) delete a.nodeRef;
      for (const g of v1.snapshots[0].moduleGains ?? []) delete g.nodeRef;
      // v1 里同名同级无法表达 → 先用校验器确认被拒（避免误以为可恢复）
      check('v1 同名同级同样被拒绝并说明原因',
        validateBackupPayload(v1).some((e) => String(e.message).includes('同路径重名')), '未拒绝');
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
