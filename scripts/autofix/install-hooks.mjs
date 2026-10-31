#!/usr/bin/env node
/**
 * 安装 Git 护栏钩子（COMP-003 / M9：把「不推 main」从自律升级为强制）。
 * 写入 .git/hooks/pre-commit 与 pre-push，一律调用 mg-branch-guard.mjs 校验。
 * 用法：node scripts/autofix/install-hooks.mjs
 * 幂等：重复执行覆盖为当前版本；不修改远端配置。
 */
import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hooksDir = resolve(repoRoot, '.git/hooks');
if (!existsSync(resolve(repoRoot, '.git'))) {
  process.stderr.write('E_BRANCH_GUARD: 当前目录不是 Git 仓库\n');
  process.exit(2);
}
mkdirSync(hooksDir, { recursive: true });

const preCommit = `#!/usr/bin/env bash
set -euo pipefail
branch="$(git rev-parse --abbrev-ref HEAD)"
case "$branch" in
  fix/*) node scripts/autofix/mg-branch-guard.mjs check ;;
  *) : ;; # 非 fix 分支按仓库常规流程提交（推送仍由 pre-push 统一拦截 main/非 fix 目标）
esac
`;

const prePush = `#!/usr/bin/env bash
set -euo pipefail
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "\${remote_ref:-}" ] && continue
  node scripts/autofix/mg-branch-guard.mjs assert-push origin "\${remote_ref}" || exit 1
done
`;

for (const [name, body] of [['pre-commit', preCommit], ['pre-push', prePush]]) {
  const path = resolve(hooksDir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  process.stdout.write(`installed ${path}\n`);
}
