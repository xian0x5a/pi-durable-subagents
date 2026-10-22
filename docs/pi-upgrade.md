# Pi upgrades

Pi releases every few days, so upgrades are automated:

1. Dependabot (`.github/dependabot.yml`) checks npm daily at 14:00 Pacific (its most frequent schedule), exempts Pi from its default 3-day release cooldown, and opens one PR bumping the four `@earendil-works/pi-*` devDependencies.
2. The **Pi upgrade** Claude Code routine runs on that PR and follows the procedure below. Its GitHub trigger is `pull_request.opened`, filtered to author `dependabot[bot]` and a title containing `the pi group`. Its prompt:

   > Follow docs/pi-upgrade.md for the pull request that triggered this run. You may push to that pull request's head branch, label it, and merge it, as the procedure describes.

The agent merges only when it is confident; anything else stays open for a human, with the reason in a PR comment. When the upgrade changed `src/`, the agent labels the PR for release, and merging it publishes a release (see [Development](development.md#releasing)).

When a newer Pi release arrives while a Pi PR is open, Dependabot closes that PR as superseded and opens a new one, which starts a new run. That run carries over the fixes from the closed PR.

To pause, switch the routine off at claude.ai/code/routines. To stop the PRs too, set `open-pull-requests-limit: 0` in `.github/dependabot.yml`, or delete the file.

## Procedure

The run starts on the Dependabot PR's head commit in a Claude Code cloud session. Two limits of that environment shape the steps:

- `gh pr` and `gh issue` use GraphQL, which the session's GitHub proxy rejects. Use the REST API through `gh api repos/xian0x5a/pi-durable-subagents/...`.
- Only this repository is reachable through GitHub. Read Pi's changes from its published changelog instead.

If a step cannot be completed, stop, and comment on the PR with what failed and what remains to be done by hand.

### 1. Prepare

Confirm the triggering PR is open, was opened by `dependabot[bot]`, and has `the pi group` in its title. If not, stop without commenting: the routine's trigger filter is misconfigured, and this PR is not yours to touch.

Run `git fetch origin main`. Check that `node --version` meets `engines.node` in `package.json`, then run `npm ci`.

Look for a Pi PR that Dependabot closed as superseded by this one. If it has commits not authored by Dependabot, cherry-pick them onto this branch, and read its comments for decisions already made.

### 2. Read what changed

Read the sections of `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` newer than the Pi version on `main` (`git show origin/main:package.json`). Sort each entry:

| Entry | Action |
|---|---|
| Breaks or changes behavior this package relies on | Fix it in this PR |
| New capability that would let this package delete or simplify code | File an issue |
| Upstream bug or regression that affects this package | File an issue here, not upstream |
| Anything else | Nothing |

### 3. Fix

Commit fixes with semantic messages and push them to the PR's head branch (`git push origin HEAD:<head branch>`), not to a new branch. Keep the PR to the bump and the changes it requires; follow `AGENTS.md`.

Raise the `peerDependencies` floor to the new version only when `src/` now needs something older Pi lacks; otherwise leave it. If the Agent selector's appearance changed, the README screenshot must be regenerated; that needs `rsvg-convert`, so if it is missing, say so and do not merge.

### 4. Check

Run `npm run typecheck`, `npm run test:ci`, and `npm run test:conformance`. The conformance suite launches real Pi processes and can run for many minutes on a slow machine; give it a long timeout or run it in the background. The rest of the process suite is not run here, so releases from these PRs go out without it.

If a check fails, find out whether the new Pi causes it. Check out `origin/main` in a separate worktree, run `npm ci` there so it uses the old Pi, and rerun the failing check. A failure that also happens there, for the same reason, is pre-existing: it does not block this PR, but file an issue for it. A failure that happens only with the new Pi blocks the merge until it is fixed.

### 5. File issues

List the existing issues first and comment on a match instead of opening a duplicate:

```bash
gh api -X GET 'repos/xian0x5a/pi-durable-subagents/issues?state=all&per_page=100'
```

Create new ones with the `pi-upgrade` label. Each one quotes the changelog entry and names the code it affects.

```bash
gh api repos/xian0x5a/pi-durable-subagents/issues -f title='<title>' -f body='<body>' -f 'labels[]=pi-upgrade'
```

### 6. Decide

When `src/` changed, label the PR for release, so that merging it publishes one. Use `release:minor` if you raised the `peerDependencies` floor, since users on older Pi can no longer install the new version; otherwise use `release:patch`. Label it even if you will not merge, so the human who does gets the release too.

```bash
gh api repos/xian0x5a/pi-durable-subagents/issues/<number>/labels -f 'labels[]=release:patch'
```

A version-only bump gets no label: it changes nothing for users, since npm does not install devDependencies and the peer range already admits the new Pi.

Merge only when all of these hold:

- the checks pass, apart from failures step 4 shows are pre-existing;
- no existing test was deleted or weakened;
- you are confident the change is correct.

When `src/` changed, an independent reviewer must also approve before you merge: a subagent given only the changelog sections and the PR diff, asked to find what the upgrade breaks.

Comment on the PR with the changelog sorting, check results, issues filed, and the decision with its reason. If you are not merging, stop here.

### 7. Merge

Stop if the PR has been closed in the meantime. Merge exactly the commit you checked, so that nothing pushed since slips in untested:

```bash
gh api -X PUT repos/xian0x5a/pi-durable-subagents/pulls/<number>/merge -f merge_method=merge -f sha="$(git rev-parse HEAD)"
```

A labelled merge starts the Release on merge workflow, which bumps the version, tags it, and publishes.
