---
status: open
---

## Goal

Make child compaction follow Pi's own decisions and completion edges: stop cancelling compaction Pi needs mid-Run, stop waiting on an event that never comes, remove our duplicate threshold check, and replace the Owner's 100 ms post-compaction guess with a fact the child already has.

## Intention

Investigation against Pi 1.4.0 and pi-codex-conversion 4.0.5 found the extension hook itself needs no integration. The real problems sit in our compaction checks. Each change removes a guess or a duplicate rather than adding policy.

## Scope & Constraints

1. `ChildTurnCompactionGateway.beforeCompaction` cancels only post-Run threshold compaction, never mid-Run.
2. `waitForCompaction` also ends for branch summaries, which set `isCompacting` but emit no `compaction_end`.
3. Delete the gateway's native threshold recheck. Pi's `_startRun` → `_prepareRun` → `_checkCompaction` already covers custom starts, with per-model settings and the true `threshold` reason. Working-Zone Preparation stays.
4. Replace `RUNTIME_ACTIVITY_SETTLEMENT_GRACE_MS` with a child-side fact: hold the compaction-finished edge until input Pi handed to `session.prompt` inside `compaction_end` has resolved or its Run has started.

Out of scope: any pi-codex-conversion integration. The user intends to remove it, so `docs/owner-workflow.md` only records that provenance reaches Pi's summarizer and may not reach extension-owned strategies.

## Behavior changes

- Native-threshold compaction failure no longer blocks a custom Delivery. Pi logs it and continues, as it does for native prompts. A Working-Zone failure now always warns and continues; Pi's run-start check then applies at the native threshold.
- `compacting` status can stay visible through a queued input's `input` and `before_agent_start` hooks.

## Work Plan

1. An independent agent writes regression tests at public seams and confirms each fails for the expected reason on the unfixed code.
2. Implement 1 and 2 in `child-turn-compaction-gateway.ts`.
3. Implement 3: rename `prepareIdleCustomTurn` to `prepareWorkingZone`, drop native threshold code, update tests that encode the removed behavior.
4. Implement 4 in `pending-native-starts.ts`, `native-session-driver.ts`, and `agent-runtime-supervisor.ts`.
5. Update `docs/agent-messaging.md`, `docs/run-supervision.md`, `docs/owner-workflow.md`, `docs/adr/0003-continuation-working-zone-preparation.md`, and `GLOSSARY.md`.
6. An independent agent reviews the final change.

## Validation

Run scoped files through `npm run test:fast|test:process|test:conformance -- --file=...`.

## Failure cases to prove

- Delivery cancelled while Pi compacts inside `_startRun` stays uncommitted.
- A compaction that starts while an earlier completion is held does not report finished early.
- A queued prompt handled by an `input` hook, or a Run that never starts, does not leave `compacting` stuck.
- Compaction inside a Run still reports finished, with no new `agent_start` to wait for.

## Known limits

Input queued behind an extension command is handed to `session.prompt` only after that command finishes, so it is not visible at `compaction_end`. The removed timer covered this for at most 100 ms.

## Progress

- Worktree `.worktrees/compaction-admission`, branch `fix/compaction-admission`, Pi 1.4.0 installed.

## Decisions

- Delete the native check rather than pass `model` to `getCompactionSettings`. Passing the model keeps a duplicate that still reports `manual` to hooks.
- Hold the edge in the child rather than lengthen the timer or add an Owner-to-child probe. The child can observe the handoff directly and Control events are ordered.
- Rejected: registering on pi-codex-conversion's compaction preparation channel and projecting `branchEntries`. No consumer remains once PCC is removed.

## Surprises & Discoveries

- Pi's custom starts have checked compaction since at least 1.3.0; plan 140's note says otherwise.
- Pi's `isCompacting` covers branch summaries, and automatic compaction clears it only after `session_compact_failed` handlers on the failure path. That lag is harmless because automatic compaction runs inside an active Run.

## Outcomes & Retrospective
