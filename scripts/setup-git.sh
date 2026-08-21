#!/usr/bin/env bash
# One-time git setup for OneGTM collaborators. Makes the branch -> commit -> PR -> squash-merge -> pull
# workflow (CONTRIBUTING.md) frictionless. Safe + idempotent — re-running just re-applies the same settings.
# Affects your GLOBAL git config (all repos). Everything here is reversible: `git config --global --unset <key>`.
#
#   Run once:  bash scripts/setup-git.sh
set -euo pipefail

echo "→ Applying frictionless git config (global)…"

# --- behaviour that removes friction ---
git config --global push.autoSetupRemote true   # `git push` on a NEW branch auto-creates the upstream (no -u)
git config --global push.default current         # push the current branch to a same-named remote branch
git config --global pull.rebase true             # `git pull` always rebases (clean linear history, matches the doc)
git config --global rebase.autoStash true        # auto-stash/restore uncommitted work around a pull/rebase
git config --global fetch.prune true             # drop local refs for branches deleted on the remote
git config --global rerere.enabled true          # remember how you resolved a conflict; auto-apply it next time
git config --global merge.conflictstyle zdiff3   # clearer 3-way conflict markers (shows the common base)
git config --global help.autocorrect prompt      # typo a command -> git offers the correction
git config --global branch.sort -committerdate   # `git branch` lists most-recent first
git config --global init.defaultBranch main

# --- one-word workflow aliases ---
# git new <name>   : start a fresh branch off the latest main (checkout main, pull --rebase, branch)
git config --global alias.new '!f(){ git checkout main && git pull --rebase origin main && git checkout -b "$1"; }; f'
# git save ["msg"] : stage everything and commit (defaults to a wip message)
git config --global alias.save '!f(){ git add -A && git commit -m "${1:-wip}"; }; f'
# git sync         : pull the latest main into your current branch (rebase; autostash handles dirty trees)
git config --global alias.sync '!git pull --rebase origin main'
# git ship         : push the current branch and open a PR into main (uses commit messages to fill it)
git config --global alias.ship '!f(){ git push && gh pr create --fill --base main; }; f'
# git land         : squash-merge THIS branch's PR into main and delete the branch (the reviewer/owner runs this)
git config --global alias.land '!gh pr merge --squash --delete-branch'
# git cleanup      : prune remotes, then delete local branches whose upstream is gone (post-merge tidy)
git config --global alias.cleanup '!git fetch -p && git branch -vv | grep ": gone]" | awk "{print \$1}" | xargs -r git branch -D'
# git undo         : undo the last commit but keep the changes staged
git config --global alias.undo 'reset --soft HEAD~1'
# handy short forms
git config --global alias.st 'status -sb'
git config --global alias.lg 'log --oneline --graph -15'
git config --global alias.co 'checkout'
git config --global alias.br 'branch'

# --- gh aliases (optional; only if the GitHub CLI is installed) ---
if command -v gh >/dev/null 2>&1; then
  gh alias set prc 'pr create --fill --base main' --clobber >/dev/null 2>&1 || true
  gh alias set prm 'pr merge --squash --delete-branch' --clobber >/dev/null 2>&1 || true
  echo "→ gh aliases set: gh prc (create PR), gh prm (squash-merge)."
else
  echo "→ (gh not found — install the GitHub CLI to enable 'git ship' / 'git land'.)"
fi

cat <<'DONE'

✓ Done. Your everyday flow is now:

    git new feature/thing     # branch off the latest main
    …work…
    git save "add the thing"  # stage + commit (or just: git save)
    git ship                  # push + open the PR
    # reviewer: git land       # squash-merge + delete branch
    git sync                  # pull latest main into your branch anytime

Nothing else to remember. `git push` on a new branch just works; `git pull` always rebases.
DONE
