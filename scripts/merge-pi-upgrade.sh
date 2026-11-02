#!/usr/bin/env bash
# Merges one Dependabot Pi upgrade PR once GitHub CI passes on the exact commit.
#
# .claude/settings.json lets Claude run this script with no human approval, and
# a labelled merge publishes to npm, so these checks are that release's gate.
# REST only: the cloud session's GitHub proxy rejects GraphQL.
set -euo pipefail

readonly REPOSITORY="xian0x5a/pi-durable-subagents"
readonly BASE_BRANCH="main"
readonly UPGRADE_PR_AUTHOR="dependabot[bot]"
readonly UPGRADE_PR_TITLE_MARKER="the pi group"
readonly CI_POLL_SECONDS=30
readonly CI_POLL_ATTEMPTS=60 # 30 minutes: macOS runners can queue for a long time

fail() {
	echo "merge-pi-upgrade: $*" >&2
	exit 1
}

require_upgrade_pull_request() {
	local state author base head_sha title
	IFS=$'\t' read -r state author base head_sha title < <(
		gh api "repos/$REPOSITORY/pulls/$pull_request" \
			--jq '[.state, .user.login, .base.ref, .head.sha, .title] | @tsv'
	)

	[[ "$state" == "open" ]] || fail "PR #$pull_request is $state, not open"
	[[ "$author" == "$UPGRADE_PR_AUTHOR" ]] || fail "PR #$pull_request is by $author, not $UPGRADE_PR_AUTHOR"
	[[ "$base" == "$BASE_BRANCH" ]] || fail "PR #$pull_request targets $base, not $BASE_BRANCH"
	[[ "$title" == *"$UPGRADE_PR_TITLE_MARKER"* ]] || fail "PR #$pull_request title lacks '$UPGRADE_PR_TITLE_MARKER': $title"
	[[ "$head_sha" == "$commit" ]] || fail "PR #$pull_request head is $head_sha, not the checked commit $commit"
}

# Prints "passed" or "pending", and fails on any unsuccessful check. No check
# runs yet is "pending", not "passed": they appear a moment after a push.
ci_state() {
	local check_runs failed unfinished
	check_runs="$(
		gh api --paginate "repos/$REPOSITORY/commits/$commit/check-runs?per_page=100" \
			--jq '.check_runs[] | "\(.status) \(.conclusion) \(.name)"'
	)"
	failed="$(grep '^completed ' <<<"$check_runs" | grep -Ev '^completed (success|neutral|skipped) ' || true)"
	unfinished="$(grep -v '^completed ' <<<"$check_runs" || true)"

	[[ -z "$failed" ]] || fail "CI failed on $commit:"$'\n'"$failed"
	if [[ -z "$check_runs" || -n "$unfinished" ]]; then
		echo "pending"
	else
		echo "passed"
	fi
}

wait_for_ci() {
	local attempt state
	for ((attempt = 1; attempt <= CI_POLL_ATTEMPTS; attempt++)); do
		state="$(ci_state)"
		[[ "$state" == "pending" ]] || return 0
		sleep "$CI_POLL_SECONDS"
	done
	fail "CI did not finish on $commit in time"
}

merge_commit() {
	# `sha` makes GitHub refuse the merge if the head moved during the CI wait.
	gh api -X PUT "repos/$REPOSITORY/pulls/$pull_request/merge" \
		-f merge_method=merge -f sha="$commit" --jq '.sha'
}

[[ $# -eq 2 ]] || fail "usage: merge-pi-upgrade.sh <pull request number> <full commit sha>"
readonly pull_request="$1" commit="$2"
[[ "$pull_request" =~ ^[0-9]+$ ]] || fail "not a pull request number: $pull_request"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "not a full commit sha: $commit"

require_upgrade_pull_request
wait_for_ci
merge_commit
