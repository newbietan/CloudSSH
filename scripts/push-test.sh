#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --e2e=chromium|--e2e=skip)
    [[ $# -eq 1 ]] || exit 2
    profile=${1#--e2e=}
    ;;
  --help|-h)
    printf '%s\n' 'Usage: bash scripts/push-test.sh --e2e=chromium|--e2e=skip' \
      'Push test with a one-off browser test selection. Plain git push origin test runs full checks.'
    exit 0
    ;;
  *) printf '%s\n' 'Choose --e2e=chromium or --e2e=skip; use plain git push origin test for full checks.' >&2; exit 2 ;;
esac

if [[ $(git branch --show-current) != test || -n $(git status --porcelain) ]]; then
  printf '%s\n' 'Use a clean test branch; commit your changes before pushing.' >&2
  exit 1
fi

git fetch --no-tags origin test
git merge-base --is-ancestor FETCH_HEAD HEAD || {
  printf '%s\n' 'Local test is behind or has diverged; sync it before pushing.' >&2
  exit 1
}
if git diff --quiet FETCH_HEAD HEAD --; then
  printf '%s\n' 'No pending file changes; an empty marker alone will not trigger this workflow.' >&2
  exit 1
fi

# GitHub Actions does not receive arbitrary git push options. Use an empty
# commit without changing or amending the actual code commit.
git commit --allow-empty -m 'ci: 设置本次 test 推送的浏览器测试' -m "CloudSSH-Test-E2E: $profile"
git push origin HEAD:refs/heads/test
