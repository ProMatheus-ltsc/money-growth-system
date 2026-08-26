#!/usr/bin/env node
/**
 * S9 线上动态冒烟（2026-08-27，V1.4 去 R2 后）
 * 覆盖核心路径：邀请码门控 → 登录 → 资产树/分类 → 负债 → 当月快照（勾稽）→
 * 报表 → 本地备份导出 → AI 导出 → PDF → 折旧/健康/用户管理扩展。
 *
 * 用法（Node 18+，内置 fetch）：
 *   node scripts/smoke-online.mjs <BASE_URL> <INVITE_CODE> <ADMIN_USER> <ADMIN_PASS>
 *   例：node scripts/smoke-online.mjs https://fam-asset-tracker.pages.dev FAM2026 admin admin123456
 *
 * 前置：已初始化管理员账号（POST /api/auth/init 完成）。
 */
const BASE = (process.argv[2] || 'https://fam-asset-tracker.pages.dev').replace(/\/$/, '');
const CODE = process.argv[3];
const UNAME = process.argv[4];
const UPASS = process.argv[5];
if (!CODE || !UNAME || !UPASS) {
  console.error('用法: node scripts/smoke-online.mjs <BASE_URL> <INVITE_CODE> <ADMIN_USER> <ADMIN_PASS>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) { pass++; console.log(`  ✅ ${name}`); }
function bad(name, detail) { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

// 当前月（客户端本地时区，用户在中国时区与服务端一致）
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

console.log(`\n[S9 线上冒烟] ${BASE} ｜ 当月=${month}\n`);

// ---------- 1. 邀请码门控 ----------
console.log('① 认证与门控');
let gateToken = '';
{
  const r = await api('/api/auth/verify-invite', { method: 'POST', body: { code: CODE } });
  if (r.status === 200 && r.json?.success && r.json.data?.gateToken) {
    gateToken = r.json.data.gateToken;
    ok('verify-invite 通过，获得 gateToken');
  } else bad('verify-invite', `${r.status} ${JSON.stringify(r.json?.error || r.json)}`);

  const rNoCode = await api('/api/auth/login', { method: 'POST', body: { username: UNAME, password: UPASS } });
  check('无 gateToken 登录被拒 (GATE_REQUIRED)', rNoCode.status === 403 && rNoCode.json?.error?.code === 'GATE_REQUIRED', `${rNoCode.status} ${rNoCode.json?.error?.code}`);
}

let token = '';
let viewerToken = '';
{
  if (gateToken) {
    const r = await api('/api/auth/login', { method: 'POST', body: { username: UNAME, password: UPASS, gateToken } });
    if (r.status === 200 && r.json?.success && r.json.data?.token) {
      token = r.json.data.token;
      ok(`login 成功（role=${r.json.data.role}）`);
    } else bad('login', `${r.status} ${JSON.stringify(r.json?.error)}`);
  }
  if (token) {
    const r = await api('/api/auth/me', { token });
    check('GET /api/auth/me', r.status === 200 && r.json?.data?.username === UNAME, `${r.status} ${JSON.stringify(r.json)}`);
    // 无 token → 401
    const r401 = await api('/api/tree');
    check('无 token 401', r401.status === 401, `got ${r401.status}`);
  }
}

// ---------- 2. 资产树 / 分类 / 负债 ----------
console.log('② 基础配置');
let treeConfigId = 0;
let catConfigId = 0;
let leafNodes = [];
let leafCatItems = [];
{
  const r = await api('/api/tree', { token });
  if (r.status === 200 && r.json?.success) {
    const d = r.json.data;
    treeConfigId = d.configId;
    const parents = new Set(d.nodes.map((n) => n.parent_id));
    leafNodes = d.nodes.filter((n) => !parents.has(n.id) && n.enabled !== false);
    check('GET /api/tree 含末级节点', leafNodes.length > 0, `leaf=${leafNodes.length}`);
  } else bad('GET /api/tree', `${r.status} ${JSON.stringify(r.json?.error)}`);

  const r2 = await api('/api/cat-configs', { token });
  if (r2.status === 200 && r2.json?.success) {
    catConfigId = r2.json.data.configId;
    leafCatItems = r2.json.data.items.filter((i) => !r2.json.data.items.some((p) => p.id === i.parent_id));
    check('GET /api/cat-configs 含二级分类', leafCatItems.length > 0, `leafCat=${leafCatItems.length}`);
  } else bad('GET /api/cat-configs', `${r2.status} ${JSON.stringify(r2.json?.error)}`);
}

let debtId = 0;
{
  const r = await api('/api/debts', {
    method: 'POST', token,
    body: { name: '冒烟房贷', debtType: 'mortgage', term: 'long', balance: 800000, annualRate: 0.045, monthlyPayment: 5000, fixedRepayment: true },
  });
  if (r.status === 200 && r.json?.success && r.json.data?.id) {
    debtId = r.json.data.id;
    ok('POST /api/debts 建负债');
  } else bad('POST /api/debts', `${r.status} ${JSON.stringify(r.json?.error)}`);
}

// ---------- 3. 当月快照（勾稽） ----------
console.log('③ 当月快照保存与勾稽');
{
  const assets = leafNodes.map((n) => ({ nodeId: n.id, balance: 10000, hasNewFunds: false, updateSource: 'current' }));
  const income = leafCatItems.filter((i) => i.direction === 'income').slice(0, 2).map((i, idx) => ({ catItemId: i.id, amount: 1000 + idx * 500 }));
  const expense = leafCatItems.filter((i) => i.direction === 'expense').slice(0, 2).map((i, idx) => ({ catItemId: i.id, amount: 300 + idx * 100 }));
  const debts = debtId ? [{ debtId, balance: 800000, repayment: null }] : [];
  const r = await api(`/api/snapshots/${month}`, {
    method: 'PUT', token,
    body: { treeConfigId, catConfigId, assets, moduleGains: [], income, expense, largeItems: [], debts },
  });
  if (r.status === 200 && r.json?.success) {
    const t = r.json.data.totals;
    const expAssets = assets.reduce((s, a) => s + a.balance, 0);
    const expIncome = income.reduce((s, x) => s + x.amount, 0);
    const expExpense = expense.reduce((s, x) => s + x.amount, 0);
    check('PUT 快照成功', true, '');
    check(`勾稽 totalAssets=${expAssets}`, Math.abs(t.totalAssets - expAssets) < 0.01, `got ${t.totalAssets}`);
    check(`勾稽 totalIncome=${expIncome}`, Math.abs(t.totalIncome - expIncome) < 0.01, `got ${t.totalIncome}`);
    check(`勾稽 balance=${expIncome - expExpense}`, Math.abs(t.balance - (expIncome - expExpense)) < 0.01, `got ${t.balance}`);
  } else bad('PUT /api/snapshots/{month}', `${r.status} ${JSON.stringify(r.json?.error || r.json)}`);

  const r2 = await api(`/api/snapshots/${month}`, { token });
  check('GET /api/snapshots/{month}', r2.status === 200 && r2.json?.success && r2.json.data.exists, `${r2.status} ${JSON.stringify(r2.json?.error)}`);

  // 历史月锁定
  const past = month === '2026-08' ? '2026-07' : '2020-01';
  const r3 = await api(`/api/snapshots/${past}`, { method: 'PUT', token, body: { treeConfigId, catConfigId, assets, moduleGains: [], income, expense, largeItems: [], debts } });
  check(`历史月拒绝 (HISTORY_LOCKED)`, r3.status === 409 && r3.json?.error?.code === 'HISTORY_LOCKED', `${r3.status} ${r3.json?.error?.code}`);
}

// ---------- 4. 报表 ----------
console.log('④ 报表');
{
  const r = await api(`/api/reports/assets?month=${month}`, { token });
  const d = r.json?.data;
  check('GET /api/reports/assets', r.status === 200 && d && ['kpis', 'trend', 'treemap', 'sankey', 'gainCompare', 'updateStatus'].every((k) => k in d), `${r.status} ${JSON.stringify(r.json?.error)}`);
  const r2 = await api(`/api/reports/finance?month=${month}`, { token });
  const d2 = r2.json?.data;
  check('GET /api/reports/finance', r2.status === 200 && d2 && ['balanceSheet', 'incomeStatement'].every((k) => k in d2), `${r2.status} ${JSON.stringify(r2.json?.error)}`);
}

// ---------- 5. 备份导出（本地） ----------
console.log('⑤ 本地备份导出');
{
  const r = await fetch(`${BASE}/api/backups/export`, { headers: { Authorization: `Bearer ${token}` } });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* 附件流或非 JSON */ }
  check('GET /api/backups/export', r.status === 200 && parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.treeConfigs) && Array.isArray(parsed.snapshots), `status=${r.status} schema=${parsed?.schemaVersion}`);
}

// ---------- 6. AI 导出 + PDF ----------
console.log('⑥ AI 导出与 PDF');
{
  const r = await api(`/api/ai/export?month=${month}`, { token });
  const text = r.json?.data?.text || '';
  const hasSections = ['## 数据', '## 提示词', '## 结果格式', '## 示例'].every((s) => text.includes(s));
  check('GET /api/ai/export 四分区', r.status === 200 && hasSections, `${r.status} sections=${hasSections}`);
  const r2 = await api(`/api/pdf/payload?scope=month&month=${month}`, { token });
  const d2 = r2.json?.data;
  check('GET /api/pdf/payload', r2.status === 200 && d2 && d2.meta?.noPII === true, `${r2.status} ${JSON.stringify(r2.json?.error)}`);
}

// ---------- 7. 扩展功能（折旧/健康/用户） ----------
console.log('⑦ 扩展功能');
{
  if (treeConfigId && leafNodes[0]) {
    const r = await api('/api/depreciation', {
      method: 'POST', token,
      body: { nodeId: leafNodes[0].id, configId: treeConfigId, depreciationCategory: 'electronics', originalValue: 5000, purchaseDate: '2025-06', usefulLifeMonths: 60, salvageRate: 0.1, salvageMode: 'rate' },
    });
    check('POST /api/depreciation', r.status === 200 && r.json?.success, `${r.status} ${JSON.stringify(r.json?.error)}`);
    const rBad = await api('/api/depreciation', {
      method: 'POST', token,
      body: { nodeId: leafNodes[0].id, configId: treeConfigId, depreciationCategory: 'electronics', originalValue: 5000, purchaseDate: '2025-06', usefulLifeMonths: 60, salvageRate: 5, salvageMode: 'rate' },
    });
    check('折旧 salvageRate>1 被拒', rBad.status === 400, `got ${rBad.status}`);
  }
  const rHealth = await api('/api/health', { token });
  check('GET /api/health', rHealth.status === 200 && rHealth.json?.success, `${rHealth.status} ${JSON.stringify(rHealth.json?.error)}`);
  const rUsers = await api('/api/auth/users', { token });
  check('GET /api/auth/users (admin)', rUsers.status === 200 && Array.isArray(rUsers.json?.data), `${rUsers.status} ${JSON.stringify(rUsers.json?.error)}`);
  const rReg = await api('/api/auth/register', { method: 'POST', body: {} });
  check('register 端点已删除 (404)', rReg.status === 404, `got ${rReg.status}`);
}

// ---------- 汇总 ----------
console.log(`\n========================================`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log(`失败项：${failures.join('、')}`);
  process.exit(1);
}
console.log('S9 线上冒烟全部通过 ✅');
