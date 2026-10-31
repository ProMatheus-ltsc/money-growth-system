#!/usr/bin/env node
/**
 * 唯一允许的推送包装（COMP-003 / M9）：先跑分支护栏再执行 git push，禁止直接调用 git push。
 * 用法：node scripts/autofix/mg-push.mjs <remote> <branch>
 * 退出码：0 推送成功；1 护栏拒绝或推送失败（E_BRANCH_GUARD / E_VERIFY_FAILED）；2 用法错误。
 */
import { execFileSync } from 'node:child_process';

const [remote, branch] = process.argv.slice(2);
if (!remote || !branch) {
  process.stderr.write('用法: mg-push.mjs <remote> <fix/...-branch>\n');
  process.exit(2);
}

try {
  execFileSync(process.execPath, ['scripts/autofix/mg-branch-guard.mjs', 'assert-push', remote, branch], {
    stdio: 'inherit',
  });
} catch {
  process.stderr.write('E_BRANCH_GUARD: 护栏拒绝推送\n');
  process.exit(1);
}

try {
  execFileSync('git', ['push', remote, branch], { stdio: 'inherit' });
} catch {
  process.stderr.write('PUSH_FAILED: git push 失败（网络/权限）；保留本地现场并报告用户。推送前须已通过 mg-verify 全部验证\n');
  process.exit(1);
}
