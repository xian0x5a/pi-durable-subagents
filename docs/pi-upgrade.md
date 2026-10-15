# Pi upgrades

Pi releases every few days, so upgrades are automated:

1. Dependabot (`.github/dependabot.yml`) checks npm hourly from 05:07 to 19:07 Pacific and opens one PR bumping the four `@earendil-works/pi-*` devDependencies.
2. The **Pi upgrade** Claude Code routine runs on that PR and follows the procedure below. Its GitHub trigger is `pull_request.opened`, filtered to author `dependabot[bot]` and a title containing `the pi group`. Its prompt is: "Follow docs/pi-upgrade.md for the pull request that triggered this run."

The agent merges only when it is confident, and publishes a release only when the upgrade changed `src/`. Anything else stays open for a human, with the reason in a PR comment. A Pi PR left open can keep later Pi releases from starting a run, so merge or close it.

To pause, switch the routine off at claude.ai/code/routines. To stop the PRs too, set `open-pull-requests-limit: 0` in `.github/dependabot.yml`, or delete the file.

## Procedure

The run starts on the Dependabot PR's head commit in a Claude Code cloud session. Three limits of that environment shape the steps:

- `gh pr` and `gh issue` use GraphQL, which the session's GitHub proxy rejects. Use the REST API through `gh api repos/xian0x5a/pi-durable-subagents/...`.
- The proxy rejects tag pushes. Create the release tag through the REST API.
- Only this repository is reachable through GitHub. Read Pi's changes from its published changelog instead.

### 1. Prepare

Check that `node --version` meets `engines.node` in `package.json`, then run `npm ci`.

### 2. Read what changed

Read the sections of `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` newer than the Pi version on `main` (`git show origin/main:package.json`). Sort each entry:

| Entry | Action |
|---|---|
| Breaks or changes behavior this package relies on | Fix it in this PR |
| New capability that would let this package delete or simplify code | File an issue |
| Upstream bug or regression that affects this package | File an issue here, not upstream |
| Anything else | Nothing |

### 3. Fix

Commit fixes with semantic messages and push them to the PR's branch. Keep the PR to the bump and the changes it requires; follow `AGENTS.md`.

Raise the `peerDependencies` floor to the new version only when `src/` now needs something older Pi lacks; otherwise leave it. If the Agent selector's appearance changed, the README screenshot must be regenerated; that needs `rsvg-convert`, so if it is missing, say so and do not merge.

### 4. Check

Run `npm run typecheck`, `npm run test:fast`, and `npm run test:conformance`. The process suite is not run here, so automated releases go out without it (see [Development](development.md#releasing)).

If a check fails, rerun the same check on `origin/main` in this session. A failure that also happens on `main`, for the same reason, is a pre-existing or environmental problem: it does not block this PR, but file an issue for it.

### 5. File issues

Search existing issues first (`gh api search/issues -f q='repo:xian0x5a/pi-durable-subagents is:issue <terms>'`) and comment on a match instead of opening a duplicate. Label new issues `pi-upgrade`. Each one quotes the changelog entry and names the code it affects.

### 6. Decide

Merge only when all of these hold:

- the checks pass, apart from failures step 4 shows also happen on `main`;
- no existing test was deleted or weakened;
- you are confident the change is correct.

When `src/` changed, an independent reviewer must also approve before you merge: a subagent given only the changelog sections and the PR diff, asked to find what the upgrade breaks.

Otherwise leave the PR open. Either way, comment on the PR with the changelog sorting, check results, issues filed, and the decision with its reason.

### 7. Merge

```bash
gh api -X PUT repos/xian0x5a/pi-durable-subagents/pulls/<number>/merge -f merge_method=merge
```

If `src/` did not change, stop here. A devDependency bump changes nothing for users: npm does not install devDependencies, and the peer range already admits the new Pi.

### 8. Release

When `src/` changed, publish a release. Bump the minor version if the `peerDependencies` floor was raised, since users on older Pi can no longer install it; otherwise bump the patch version.

```bash
git fetch origin main
git checkout -B main origin/main
npm version <minor|patch> --no-git-tag-version
version="$(node -p 'require("./package.json").version')"
git commit -am "${version}"
git push origin main
gh api repos/xian0x5a/pi-durable-subagents/git/refs -f ref="refs/tags/v${version}" -f sha="$(git rev-parse HEAD)"
```

The tag starts the Release workflow, which publishes to npm. Link its run in the PR comment.
