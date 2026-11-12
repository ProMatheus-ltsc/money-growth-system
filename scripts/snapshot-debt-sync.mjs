#!/usr/bin/env node
/**
 * 负债主档同步自测（P1：历史纠错不得回写 debts.balance_cents）：
 *   1) 保存 2026-09（首月）→ 主档应同步为 9 月余额；
 *   2) 保存 2026-10（更新月）→ 主档应推进为 10 月余额；
 *   3) 覆盖保存 2026-10（当月重存）→ 主档仍是 10 月余额；
 *   4) 「纠错」2026-09（更早月份）→ 主档必须保持 10 月余额，不得回退。
 *
 * 依赖 Node 22.5+ 的 node:sqlite。运行方式同 backup-roundtrip.mjs：
 *   node scripts/snapshot-debt-sync.mjs
 *   MGS_SNAPSHOT_BUNDLE=/tmp/snapshotWriter.mjs node scripts/snapshot-debt-sync.mjs
 * 退出码：0 全部通过；1 有用例失败。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MGS_SNAPSHOT_ENTRY
  ? path.resolve(process.env.MGS_SNAPSHOT_ENTRY)
  : path.join(repoRoot, 'backend', 'services', 'snapshotWriter.ts');
const prebuiltBundle = process.env.MGS_SNAPSHOT_BUNDLE ? path.resolve(process.env.MGS_SNAPSHOT_BUNDLE) : null;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name) { pass++; console.log(`  ✅ ${name}`); }
function bad(name, detail) { fail++; failures.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
function check(name, cond, detail = '') { cond ? ok(name) : bad(name, detail); }

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
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
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

async function main() {
  console.log(`\n[负债主档同步自测] entry=${path.relative(repoRoot, entry) || entry}\n`);
  const workDir = mkdtempSync(path.join(tmpdir(), 'mgs-debt-'));
  const bundlePath = prebuiltBundle ?? path.join(workDir, 'snapshotWriter.mjs');
  try {
    if (!prebuiltBundle) {
      const { build } = await import('esbuild');
      await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundlePath, logLevel: 'silent' });
    }
    const { validateSnapshotInput, writeSnapshot } = await import(pathToFileURL(bundlePath).href);

    const { sqlite, db } = createDb();
    const now = '2026-11-01T00:00:00Z';
    await db
      .prepare(
        `INSERT INTO debts (name, debt_type, term, balance_cents, annual_rate, monthly_payment_cents, fixed_repayment, enabled, sort_order, created_at, updated_at)
         VALUES ('房贷', 'mortgage', 'long', 90000000, 0.045, 500000, 1, 1, 0, ?, ?)`
      )
      .bind(now, now).run();
    const debt = await db.prepare("SELECT id FROM debts WHERE name = '房贷'").first();

    const tree = await db.prepare('SELECT id, version FROM tree_configs WHERE version = 1').first();
    const cat = await db.prepare('SELECT id, version FROM cat_configs WHERE version = 1').first();
    const treeNodes = (await db.prepare('SELECT id, parent_id, enabled FROM tree_nodes WHERE config_id = ?').bind(tree.id).all()).results;
    const parents = new Set(treeNodes.map((n) => n.parent_id).filter((p) => p !== null));
    const leaves = treeNodes.filter((n) => n.enabled === 1 && !parents.has(n.id));
    const catItems = (await db.prepare('SELECT id, parent_id, direction FROM cat_items WHERE config_id = ?').bind(cat.id).all()).results;
    const catParents = new Set(catItems.map((c) => c.parent_id).filter((p) => p !== null));
    const catLeaves = catItems.filter((c) => !catParents.has(c.id));

    const masterBalance = async () =>
      (await db.prepare('SELECT balance_cents FROM debts WHERE id = ?').bind(debt.id).first())?.balance_cents;

    const build = (debtBalanceYuan) => ({
      treeConfigId: tree.id,
      catConfigId: cat.id,
      assets: leaves.map((n) => ({ nodeId: n.id, balance: 1000, hasNewFunds: false, updateSource: 'current' })),
      moduleGains: [],
      income: catLeaves.filter((c) => c.direction === 'income').map((c) => ({ catItemId: c.id, amount: 100 })),
      expense: catLeaves.filter((c) => c.direction === 'expense').map((c) => ({ catItemId: c.id, amount: 10 })),
      largeItems: [],
      debts: [{ debtId: debt.id, balance: debtBalanceYuan, repayment: 5000 }],
    });

    const save = async (month, debtBalanceYuan) => {
      const errors = [];
      const v = await validateSnapshotInput(db, month, build(debtBalanceYuan), errors);
      if (!v || errors.length > 0) throw new Error(`校验失败 @${month}: ${JSON.stringify(errors)}`);
      return writeSnapshot(db, month, v);
    };

    console.log('① 首月 2026-09 保存（余额 80 万）');
    const r1 = await save('2026-09', 800000);
    check('首月写入了主档（无快照 → 视为最新）', r1.debtMasterSynced === true, `debtMasterSynced=${r1.debtMasterSynced}`);
    check('主档余额 = 80 万', (await masterBalance()) === 80000000, `got ${await masterBalance()}`);

    console.log('② 推进到 2026-10（余额 78 万）');
    const r2 = await save('2026-10', 780000);
    check('10 月为最新月 → 同步主档', r2.debtMasterSynced === true, `debtMasterSynced=${r2.debtMasterSynced}`);
    check('主档余额 = 78 万', (await masterBalance()) === 78000000, `got ${await masterBalance()}`);

    console.log('③ 覆盖保存 2026-10（余额 77 万）');
    const r3 = await save('2026-10', 770000);
    check('覆盖最新月 → 同步主档', r3.debtMasterSynced === true, `debtMasterSynced=${r3.debtMasterSynced}`);
    check('主档余额 = 77 万', (await masterBalance()) === 77000000, `got ${await masterBalance()}`);

    console.log('④ 纠错更早的 2026-09（余额改为 60 万）');
    const r4 = await save('2026-09', 600000);
    check('历史月不推进主档（debtMasterSynced=false）', r4.debtMasterSynced === false, `debtMasterSynced=${r4.debtMasterSynced}`);
    check('主档余额保持 77 万（未被历史纠错污染）', (await masterBalance()) === 77000000, `got ${await masterBalance()}`);
    const snap09 = await db.prepare("SELECT balance_cents FROM snapshot_debts sd JOIN monthly_snapshots ms ON ms.id = sd.snapshot_id WHERE ms.month = '2026-09'").first();
    check('9 月快照明细已按纠错值写入（60 万）', snap09?.balance_cents === 60000000, `got ${snap09?.balance_cents}`);

    console.log('⑤ 补录更早的 2026-08（余额 82 万）');
    const r5 = await save('2026-08', 820000);
    check('补录历史月不推进主档', r5.debtMasterSynced === false, `debtMasterSynced=${r5.debtMasterSynced}`);
    check('主档余额仍为 77 万', (await masterBalance()) === 77000000, `got ${await masterBalance()}`);

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
  console.log('负债主档同步自测全部通过 ✅\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
