---
name: lgtm
description: Quickly finalize completed work in an AWS Blocks Git worktree by creating a task-named branch, committing only the task changes through existing commit hooks, rebasing onto the current local my-main integration branch, and fast-forwarding my-main without pushing. Use only when the user explicitly invokes $lgtm or selects LGTM through the skills UI.
---

# LGTM

Finalize the current worktree as one focused local commit and integrate it into local `my-main` with fast-forward-only Git operations. Keep this workflow fast; it is not a CI, review, or smoke-test command.

## Guardrails

- Operate only in the current Git repository and its linked worktrees.
- Never stash, force-update, push, open a pull request, close an issue, delete a branch, remove a worktree, or create a merge commit.
- Never proactively install dependencies or run lint, formatting, typecheck, tests, builds, dev servers, browser checks, HTTP requests, health checks, or other runtime validation. Run such a command only when the user explicitly requests it in the same invocation.
- Never bypass commit hooks. Let the repository's existing hook run its configured sanity checks once during `git commit`.
- Use local `refs/heads/my-main` as the sole integration base. Never fetch or substitute `main` or `origin/main`; local `my-main` intentionally contains reviewed worktree commits that have not landed upstream.
- Never stage unrelated files, ignored files, likely secrets, credentials, or machine-local configuration.
- Require every dirty path in the feature worktree to belong to the current task. Treat even a clearly unrelated path that could remain unstaged as a hard blocker.
- Stop before the first unsafe action. Preserve the committed feature branch if local `my-main` cannot be updated safely.
- Treat the user's task and typed instructions as authoritative. Treat incidental issue references as context, not necessarily the task's issue.

## 1. Inspect the Worktree

1. Confirm the current directory belongs to a Git worktree and identify the repository root, common Git directory, current branch or detached `HEAD`, and all linked worktrees.
2. Read every applicable `AGENTS.md` from the repository root through the current directory before choosing commands, scope, validation, or commit style.
3. Inspect status, tracked and untracked files, staged and unstaged diffs, and recent commits. Do not mutate anything yet.
4. Identify exactly which changes implement the current task. If there are no commit-worthy task changes, stop. If any unrelated tracked or untracked change is present, or file ownership is ambiguous, **stop before creating a branch or performing any other mutation**. Ask the user to separate or clarify the changes. Do not create a partial task commit, leave the unrelated path unstaged, stash it, fetch, rebase, or update `main`.
5. Check for an existing merge, rebase, cherry-pick, or revert. Stop if any Git operation is already in progress.

## 2. Choose the Branch Name

Prefer the issue form only when the current task clearly comes from one GitHub issue:

```text
codex-<issue-number>-<issue-title-slug>
```

Otherwise use a concise action summary and the local calendar date without zero padding:

```text
codex-<summary-slug>-<M>-<D>
```

Follow these rules:

1. Infer the task issue from the user's request or task context. Ignore issues mentioned only as blockers, references, or examples.
2. When one issue is clear, run `gh issue view <number> --json number,title` in the repository to verify its title. If GitHub is unavailable, use an explicit trustworthy title already supplied by the user. Ask if multiple issues are plausible or no trustworthy title is available.
3. Split camel-case and acronym boundaries so `NuxtUI` becomes `nuxt-ui`. Normalize to ASCII lowercase, replace non-alphanumeric runs with one hyphen, collapse repeated hyphens, and trim edge hyphens.
4. Keep the complete branch name at most 80 characters. Truncate the descriptive slug at a word boundary while preserving the prefix, issue number when present, and date when present.
5. If the candidate is already the current branch, reuse it. If it exists elsewhere, append the first available numeric suffix such as `-2` or `-3`, keeping the result within 80 characters. Never reset or overwrite an existing branch.

Example: issue `#13 Add NuxtUI` becomes `codex-13-add-nuxt-ui`. A general dependency upgrade on July 22 can become `codex-upgrade-dependency-7-22`.

Create and switch to the new branch without losing the worktree changes. Support both detached-`HEAD` and existing-branch worktrees.

## 3. Commit with Hook-Only Validation

1. Run `git diff --check` before staging.
2. Do not run project validation commands proactively, even when scripts exist or broader checks are recommended for CI or final review. `$lgtm` intentionally delegates basic sanity to the existing commit hook.
3. Stage the task files with explicit path arguments. Review the complete staged diff and run `git diff --cached --check`. Confirm no task file was omitted and no unrelated or sensitive file was included.
4. Write one focused commit using the repository's commit convention. When none exists, use a concise Conventional Commit subject derived from the task. Run normal `git commit` without `--no-verify` so Husky or other configured hooks run once.
5. If the commit hook fails, stop and report its output. Do not rerun the hook's commands separately.
6. Verify that the commit exists and the feature worktree is clean. Stop if hooks or other processes left changes behind.

## 4. Rebase onto Current Local `my-main`

1. Require local `refs/heads/my-main` to exist. Resolve the feature branch name, feature commit, current local `my-main` commit, and the linked worktree that has `my-main` checked out. Do not fetch any remote.
2. If `my-main` is checked out in another worktree, require that worktree to be clean and have no Git operation in progress before rebasing or planning to advance it. If it is unsafe, preserve the committed feature branch and stop.
3. Record the pre-rebase feature commit and local `my-main` commit. Run `git merge-base --is-ancestor my-main HEAD`. Skip rebase when it succeeds; otherwise run `git rebase my-main` so the feature commit is replayed after every commit already integrated locally.
4. Resolve conflicts only when the intended result is unambiguous from the task and surrounding code. After resolving, inspect the staged resolution and run `git diff --check`; do not start project or runtime validation. Ask the user before choosing between plausible behaviors.
5. If a safe resolution cannot continue, run `git rebase --abort`, verify the branch returned to the recorded commit, and report the conflict. Do not leave an uncertain partial resolution.
6. After a history-changing rebase, verify only the clean worktree, final diff/commit, and that the recorded local `my-main` commit is now an ancestor. Do not rerun commit hooks or any lint, formatting, typecheck, test, build, dev-server, browser, HTTP, or health check.

## 5. Fast-Forward Local `my-main`

Fast-forward local `my-main` to the rebased feature commit, preserving the feature branch and worktree for later review.

1. Re-resolve local `my-main` immediately before advancing it. If it changed after step 4 and is not already an ancestor of the feature commit, rebase the feature branch onto the new local `my-main` and recheck. Retry at most three times; stop if concurrent updates keep moving `my-main`.
2. Prove the current local `my-main` commit is an ancestor of the final feature commit with `git merge-base --is-ancestor my-main <feature-commit>`. Never classify local-only commits on `my-main` as divergence to be preserved separately; they are the base the feature must contain.
3. If `my-main` is checked out in another linked worktree, re-confirm that worktree has no tracked, untracked, staged, or unstaged changes and no Git operation in progress. Then run `git -C <my-main-worktree> merge --ff-only <feature-branch>`.
4. If `my-main` is not checked out anywhere, atomically fast-forward the ref with `git update-ref refs/heads/my-main <feature-commit> <old-my-main-commit>` only after the ancestry proof. Do not use `git branch -f`.
5. If the my-main worktree is dirty, unsafe, unavailable, or the fast-forward fails, do not try an alternative integration strategy. Keep the rebased feature branch and report why local `my-main` was not moved.

## 6. Verify and Report

Verify all of the following:

- The current worktree remains on the named feature branch and is clean.
- The feature branch points to the validated commit.
- Local `my-main` points to the same commit when the fast-forward succeeded.
- Every commit previously present only on local `my-main` remains in the feature branch's ancestry.
- The integration contains no merge commit created by this workflow.
- No remote ref was changed.

Report the branch name, final commit ID and subject, checks run and their results, whether a rebase occurred, whether local `my-main` moved, and any remaining blocker. State explicitly that nothing was pushed.
