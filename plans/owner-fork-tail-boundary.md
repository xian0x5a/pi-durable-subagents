---
status: done
---

## Goal

Replace inline `^` inherited marks with one transient boundary message, so an Owner fork sends its parent's history byte-identical and no compaction strategy has to carry marks.

## Intention

`^` rewrites every inherited tool call and result into a custom message, so a fork diverges from its parent at the first inherited tool call and pays for the rest of the prefix again. It also forces marks through `session_before_compact` and `session_before_tree`, which depend on extension load order and on which event field a strategy reads. T3 Code and Codex both leave inherited history untouched and enforce scope in tools. Inherited scope already comes from the Owner Identity cutoff, so the model only needs to be told where inherited history ends.

## Scope & Constraints

1. Remove inherited marks: `projectParticipantHistoryContext`, `projectOwnerForkCompaction`, `projectOwnerForkBranch`, both hooks in `participant-lifecycle.ts`, and the `inherited` reason.
2. Remove fork provenance capture. The model no longer sees per-entry attribution. Existing sessions keep their `agent-coordination.fork-provenance` entries, so Delivery reading must keep ignoring that type.
3. In `context`, insert one transient message after the last inherited-or-summary message visible on the active branch, past any following tool results, only when the active branch holds inherited model entries.
4. `!` marks stay. The legend drops `^`.
5. Do not carry the parent's cache key: Pi has no native support. Key-based providers may still miss a fork's first turn.

## Behavior changes

- A fork's first request matches its parent's history up to the boundary.
- Per-entry source Agent attribution is gone.
- Pi's summarizer no longer receives inherited marks or coordination guidance.
- A summary after the cutoff gets the boundary after it even if it covers only current work. The boundary says "may be", and obligations come from durable evidence.

## Work Plan

1. An independent agent writes behavior tests and confirms they fail on the current code, including whether tools reject inherited Agents and Requests.
2. Implement in `owner-fork-context.ts`, `participant-lifecycle.ts`, `coordination-history-context.ts`, `replay-rejection.ts`, `coordination-history-guidance.ts`, `owner-bootstrap.ts`.
3. Delete `fork-provenance.ts` and its test, keeping the retired type's Delivery filter.
4. Update tests encoding `^` and docs: `docs/owner-workflow.md`, `docs/agent-messaging.md`, `docs/cold-host-recovery.md`, `docs/coordination-replay-rejection-design.md`, `GLOSSARY.md`.
5. An independent agent reviews the final change.

## Validation

Run scoped files through `npm run test:fast -- --file=...`, then affected process and conformance files.

## Failure cases to prove

- Branching off an inherited entry places the boundary after the branch point; new work stays below it.
- Branching before any inherited message yields no boundary.
- The boundary never separates a tool call from its results.
- A compaction keeping inherited entries puts the boundary after them in the order the model sees.
- A fresh Delivery stays the newest model-visible message.
- Reload and re-fork keep the boundary without saved state.
- An inherited Agent or Request used through a tool is rejected.

## Known limits

Inside a summary the model cannot separate inherited from current work.

A parent request carrying a `!` record or a Request presentation splits the shared prefix at that point.

## Progress

- Worktree `.worktrees/owner-fork-boundary`, branch `feat/owner-fork-tail-boundary`, stacked on `fix/compaction-admission`.
- Done: boundary in place, `^` and fork provenance capture removed, compaction and tree hooks removed, docs updated.
- Done: two independent reviews; each finding fixed test-first or recorded in Decisions.

## Decisions

- Transient, never persisted: a saved boundary would stay behind on an abandoned branch.
- Compute it after `!` projection: `mapVisibleMessages` already handles projected lists, by key rather than by position, so `projectCoordinationHistory` needs no boundary parameter.
- Insert it in `context_with_system`, not `context`: any changed `context` result makes Pi merge the system messages, which breaks the prefix on models with mid-conversation system messages.
- Require `header.parentSession`: entries before the Identity alone also describe an extension's startup message and a native session adopted later. Pi sets no parent on unsaved sessions, so their forks lose only the orientation message.
- Accept pi-codex-conversion's lenient replay cost: this repo cannot fix it, and dropping the boundary after compaction would leave a summary of inherited work unmarked.
- Rejected: summary handoff, stripping tool calls, keeping `^` (scored 3.10, 2.50, 2.25 against 4.65).

## Surprises & Discoveries

- PCC's strict replay match fails with a message after the summary, but its lenient path places the checkpoint and keeps what follows. That includes kept messages its window already covers, so they repeat on each request until the next compaction. Reproduced against PCC's real rewrite.
- A changed `context` result still merges system messages when a request carries a `!` mark or a Request presentation. An unforked Owner has the same cost, so it is left alone.
- `followsContextPrefix` was false for every production request, because extensions see no system messages and the session context keeps them. Duplicates fell through to the all-branch index.
- `^` converted inherited summaries to `custom`, which hid inherited native checkpoints from PCC's replay. Removing it fixes that.

## Outcomes & Retrospective

A fork now sends inherited history unchanged, followed by one derived boundary message, and no compaction strategy has to carry marks. `npm run test:fast` passes, as do the affected process and conformance files; `coordinated-workflow-pty` timed out once while other work loaded the machine and passed on both reruns. PCC's replay was exercised through its real rewrite function, not a full PCC session. The first design missed that a changed `context` result merges system messages, and that entries before the Identity do not prove a fork; both came from independent review.
