#!/usr/bin/env node
/**
 * Git 分支护栏（COMP-003 / REQ-006、红线：自动修复只提交 fix/*；禁止 push main、禁止合并、禁止 force）。
 * 用法：
 *   node scripts/autofix/mg-branch-guard.mjs check            # 校验当前分支可否承载修复
 *   node scripts/autofix/mg-branch-guard.mjs assert-push <remote> <ref>  # push 前校验
 *   node scripts/autofix/mg-branch-guard.mjs assert-merge <target-branch> # 合并企图校验（永远拒绝）
 * 退出码：0 允许；1 拒绝（E_BRANCH_GUARD，stderr 输出原因）；2 用法/环境错误。
 */
import { execFileSync } from 'node:child_process';

const PROTECTED = ['main', 'master'];

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    process.stderr.write(`E_BRANCH_GUARD: git ${args.join(' ')} 执行失败: ${e.message}\n`);
    process.exit(2);
  }
}

function currentBranch() {
  const b = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (b === 'HEAD') {
    process.stderr.write('E_BRANCH_GUARD: 处于 detached HEAD，禁止自动修复提交\n');
    process.exit(1);
  }
  return b;
}

function deny(reason) {
  process.stderr.write(`E_BRANCH_GUARD: ${reason}\n`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'check': {
    const branch = currentBranch();
    if (!/^fix\/.+$/.test(branch)) deny(`修复提交只允许 fix/* 分支，当前为 ${branch}`);
    process.stdout.write(`OK ${branch}\n`);
    break;
  }
  case 'assert-push': {
    const [remote, ref] = rest;
    if (!remote || !ref) {
      process.stderr.write('用法: mg-branch-guard.mjs assert-push <remote> <ref>\n');
      process.exit(2);
    }
    const branch = currentBranch();
    if (!/^fix\/.+$/.test(branch)) deny(`当前分支 ${branch} 非 fix/*，禁止推送`);
    const refSpec = String(ref);
    if (refSpec.includes('--force') || refSpec.startsWith('+')) deny('禁止 force push');
    const targetBranch = refSpec.includes(':') ? refSpec.split(':')[1] : refSpec.replace(/^refs\/heads\//, '');
    if (PROTECTED.includes(targetBranch)) deny(`禁止推送到受保护分支 ${targetBranch}；合并由用户决定`);
    if (targetBranch !== branch && !/^fix\/.+$/.test(targetBranch)) deny(`推送目标 ${targetBranch} 非 fix/*`);
    process.stdout.write(`OK push ${remote} ${refSpec} (branch=${branch})\n`);
    break;
  }
  case 'assert-merge': {
    deny('Agent 侧无合并权限：合并 fix/* 由用户在目标仓决定（契约 §4）');
    break;
  }
  default:
    process.stderr.write('用法: mg-branch-guard.mjs <check|assert-push|assert-merge> [args]\n');
    process.exit(2);
}
