#!/usr/bin/env node
/**
 * 修复验证四件套（COMP-003 / REQ-005、REQ-006）。
 * 依次执行并全部要求 exit 0，否则输出 E_VERIFY_FAILED 并以非零码退出：
 *   1) typecheck  — npm run typecheck
 *   2) build      — npm run build
 *   3) unit       — npm test         （Vitest 回归保护）
 *   4) smoke      — 只读冒烟 GET /api/health（MG_SMOKE_URL，禁止写线上；缺省跳过网络用例）
 * 用法：node scripts/autofix/mg-verify.mjs [--skip-smoke] [--skip-build]
 * 退出码：0 全绿；1 任一验证失败（E_VERIFY_FAILED）；2 用法/环境错误。
 */
import { spawnSync } from 'node:child_process';
import { smokeStatusOk } from './smoke-policy.mjs';

const args = new Set(process.argv.slice(2));
const results = [];

function run(name, cmd, cmdArgs) {
  const proc = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const code = proc.status ?? 1;
  results.push({ name, exitCode: code });
  if (code !== 0) {
    const tail = (proc.stderr || proc.stdout || '').trim().split('\n').slice(-5).join('\n');
    process.stderr.write(`[mg-verify] ${name} FAILED (exit ${code}):\n${tail}\n`);
  } else {
    process.stdout.write(`[mg-verify] ${name} OK\n`);
  }
  return code === 0;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let allOk = true;

allOk = run('typecheck', npm, ['run', 'typecheck']) && allOk;
allOk = run('support-typecheck', npm, ['run', 'typecheck:agent']) && allOk;
if (!args.has('--skip-build')) allOk = run('build', npm, ['run', 'build']) && allOk;
allOk = run('unit', npm, ['test', '--', '--run']) && allOk;

if (!args.has('--skip-smoke') && process.env.MG_SMOKE_URL) {
  const smokeOk = await readSmoke(process.env.MG_SMOKE_URL);
  results.push({ name: 'smoke', exitCode: smokeOk ? 0 : 1 });
  allOk = smokeOk && allOk;
} else {
  results.push({ name: 'smoke', exitCode: 0, skipped: true });
  process.stdout.write('[mg-verify] smoke skipped (no MG_SMOKE_URL)\n');
}

process.stdout.write(`${JSON.stringify({ verifications: results, pushedEligible: allOk })}\n`);
if (!allOk) {
  process.stderr.write('E_VERIFY_FAILED: 存在未通过验证，停止提交/推送，保留本地现场并通知用户\n');
  process.exit(1);
}
process.exit(0);

/** 只读冒烟：GET /api/health 判定服务可达，绝不发写请求。
 *  站点 /api/health 需要鉴权，401/403 同样说明服务在线（可达性冒烟不验证业务鉴权）；
 *  5xx 与网络错误才算失败。 */
async function readSmoke(baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/health`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    const reachable = smokeStatusOk(res.status);
    process.stdout.write(`[mg-verify] smoke ${reachable ? 'OK' : 'FAILED'} (HTTP ${res.status}, 仅 2xx/401/403 视为可达)\n`);
    return reachable;
  } catch (e) {
    process.stderr.write(`[mg-verify] smoke error: ${e.message}\n`);
    return false;
  }
}
