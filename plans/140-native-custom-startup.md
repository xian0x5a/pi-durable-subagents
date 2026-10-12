---
status: open
---

## Goal

Bump Pi to 1.2.0 and replace the local idle custom-startup bridge (#139) with Pi's native custom-message start, closing #140.

## Intention

Pi 1.2.0 (earendil-works/pi PR 10739, issue 5581) runs `before_agent_start` for `sendCustomMessage(..., {triggerTurn:true})`, and counts the session as busy from the start of run setup. The local empty-kickoff prompt, injection hook and preparation-busy admission duplicate that. Remove what Pi now owns and keep only what the protocol still needs.

## Upstream behavior relied on (Pi 1.2.0, `dist/core/agent-session.js`)

- `_startRun` sets `_isAgentRunActive` synchronously before preparation: `isStreaming`/`!isIdle` during `before_agent_start`. Competing `sendCustomMessage` steers into the starting Run. `prompt` without `streamingBehavior` throws "Agent is already processing".
- `BeforeAgentStartEvent` is a union on `messageType` (`"user"` | `"custom"`). Handler messages, system prompt and tool loadout apply to both and persist across tool continuations.
- `abort()` during setup aborts the Run at `agent_start`. The starting custom message still commits in that aborted Run.
- `input` handlers still do not run for custom starts. That is deliberate upstream: custom messages skip user-input processing.

## Scope & Constraints

- Remove the empty kickoff, the injection hook, prompt/custom entrypoint wrappers, preparation-busy errors, busy retry loops, reload exclusion retention and input-handoff admission release.
- Keep a native-start fence. A custom Delivery cancelled before its Run reaches `agent.prompt` must commit nothing, or retry could duplicate it. Pi's abort-during-setup does commit it, so it is not a substitute. Keep exact Run-signal capture for child cancellation.
- Keep working-zone preparation, compaction admission, queue intention sequencing, the transcript commit proof, Moderator reminder ordering and native-input forwarding (original input forced handled).
- Behavior change: custom deliveries no longer run `input` handlers. pi-codex-conversion 3.0.52 resets its Codex turn-state in `input` only, so custom-started turns skip that reset. That gap applies to every custom-started Pi turn and belongs to conversion, not this project.
- No compatibility path: historical empty kickoff entries stay as transcript data and need no migration.

## Work Plan

1. Bump all four `@earendil-works/pi-*` dev deps to 1.2.0 (done; 7 fast tests in the admission layer fail).
2. Shrink `session-startup.ts` to the native-start observer (`agent.prompt` wrapper: `beforeStart` fence, `started(signal)`). Drop registry/hook if no longer needed.
3. `NativeSessionDriver`: send custom deliveries through `session.sendCustomMessage` directly, accept synchronously, drop the busy loop; `canStartIdleTurn` becomes `session.isIdle`.
4. Owner/child adapters: drop `captureInputHandoff`, keep the child's forced-handled handoff bookkeeping.
5. Remove tests that pin superseded local behavior. An independent agent writes contract tests for the new path. Update docs (`agent-messaging.md`, `owner-workflow.md` if touched, stale comment in `coordination-tools.ts`).
6. Independent review, then PR closing #140.

## Validation

- Typecheck. Focused fast and process suites covering idle custom startup, child compaction delivery, child lifecycle, Moderator reminder, delivery failure notice, run supervision and agent request.
- Contract: first and settled idle custom Message/Request in Owner and child run `before_agent_start` once per Run, with prepared prompt kept after a tool round trip. Custom fields are kept, there is no empty user entry, and there is exactly one Delivery. Cancellation before native start commits nothing. Active steer/follow-up ordering is unchanged.

## Progress

- [x] Bump deps; record red fast tests.
- [ ] Refactor runtime.
- [ ] Prune superseded tests; independent contract tests.
- [ ] Docs.
- [ ] Review; PR.

## Surprises & Discoveries

- `preflightResult` dispositions are `"handled" | "queued" | "started"`. The local wrappers use truthiness, so they need no change.

## Decisions

- Drop `input` emulation for custom deliveries. Rejected: keeping the empty kickoff only to fire `input`. It would keep the whole admission layer alive just to contradict upstream's documented split between input processing and run preparation.
- Keep the `agent.prompt` start fence. Rejected: relying on `session.abort()` during setup. It commits the cancelled Delivery into an aborted Run.

## Outcomes & Retrospective

(pending)
