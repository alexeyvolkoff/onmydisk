#!/usr/bin/env bash
# ==============================================================================
# Clean Orphan / Incremental Sync to Public GitHub (alexeyvolkoff/onmydisk)
#
# Publishes the exact Git tree of TARGET_REF (default: HEAD) onto the clean
# public GitHub history without ever exposing pre-open-source legacy commits.
# Safe to run manually (`./scripts/push-github.sh` or `git push-gh`) and from
# GitLab CI (`build_direct`, `deploy_direct`, `deploy_direct_front`).
# Never modifies the local working tree, index, or current branch.
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TARGET_REF="${1:-HEAD}"
GITHUB_REMOTE="${GITHUB_REMOTE:-github}"
GITHUB_URL="${GITHUB_URL:-git@github.com:alexeyvolkoff/onmydisk.git}"

if ! git remote get-url "$GITHUB_REMOTE" >/dev/null 2>&1; then
  git remote add "$GITHUB_REMOTE" "$GITHUB_URL"
fi

TARGET_SHA="$(git rev-parse --verify "${TARGET_REF}^{commit}")"
TARGET_TREE="$(git rev-parse --verify "${TARGET_SHA}^{tree}")"

echo "[push-github] Checking remote '$GITHUB_REMOTE' ($GITHUB_URL)..."
REMOTE_HEADS="$(git ls-remote --heads "$GITHUB_REMOTE" main direct)"

export GIT_AUTHOR_NAME="$(git log -1 --format='%an' "$TARGET_SHA")"
export GIT_AUTHOR_EMAIL="$(git log -1 --format='%ae' "$TARGET_SHA")"
export GIT_AUTHOR_DATE="$(git log -1 --format='%aI' "$TARGET_SHA")"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

if [ -z "$REMOTE_HEADS" ]; then
  echo "[push-github] Empty GitHub repository detected — creating clean initial open-source commit..."
  NEW_SHA="$(git commit-tree "$TARGET_TREE" -m "Initial open-source release of On My Disk Direct")"
else
  git fetch --quiet "$GITHUB_REMOTE" +refs/heads/*:refs/remotes/"$GITHUB_REMOTE"/*
  if git show-ref --verify --quiet "refs/remotes/${GITHUB_REMOTE}/main"; then
    GH_PARENT="$(git rev-parse "refs/remotes/${GITHUB_REMOTE}/main")"
  else
    GH_PARENT="$(git rev-parse "refs/remotes/${GITHUB_REMOTE}/direct")"
  fi

  GH_TREE="$(git rev-parse "${GH_PARENT}^{tree}")"
  if [ "$GH_TREE" = "$TARGET_TREE" ]; then
    echo "[push-github] Tree already matches GitHub ($GH_PARENT). Ensuring main & direct refs are aligned..."
    OMD_ALLOW_CLEAN_GITHUB_PUSH=1 git push --force "$GITHUB_REMOTE" \
      "${GH_PARENT}:refs/heads/main" \
      "${GH_PARENT}:refs/heads/direct"
    echo "[push-github] Done (no tree changes)."
    exit 0
  fi

  COMMIT_MSG="$(git log -1 --format='%B' "$TARGET_SHA")"
  NEW_SHA="$(git commit-tree "$TARGET_TREE" -p "$GH_PARENT" -m "$COMMIT_MSG")"
fi

echo "[push-github] Force-syncing clean commit $NEW_SHA (from $TARGET_SHA) -> $GITHUB_REMOTE (main, direct)..."
OMD_ALLOW_CLEAN_GITHUB_PUSH=1 git push --force "$GITHUB_REMOTE" \
  "${NEW_SHA}:refs/heads/main" \
  "${NEW_SHA}:refs/heads/direct"

echo "[push-github] Successfully synced to GitHub!"
