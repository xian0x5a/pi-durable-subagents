---
status: done
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
- A prompt in its async `input` phase is not busy yet. A custom Run started then makes that prompt throw "Agent is already processing".
- `preflightResult("started")` fires through `onStarted`, outside `_startRun`'s cleanup: a throw there leaves the session busy for good.
- `sendCustomMessage` does not check compaction (`prompt` does) and would start a Run beside it.
- `prompt`/`sendCustomMessage` called while Pi emits `agent_settled` are deferred to after settlement and return at once.

## Scope & Constraints

- Remove the empty kickoff, the injection hook, prompt/custom entrypoint wrappers, preparation-busy errors, busy retry loops, reload exclusion retention and input-handoff admission release.
- Keep a native-start fence. A custom Delivery cancelled before its Run reaches `agent.prompt` must commit nothing, or retry could duplicate it. Pi's abort-during-setup does commit it, so it is not a substitute. Keep exact Run-signal capture for child cancellation.
- Keep working-zone preparation, compaction admission, queue intention sequencing, the transcript commit proof, Moderator reminder ordering and native-input forwarding (original input forced handled).
- Behavior change: custom deliveries no longer run `input` handlers. pi-codex-conversion 3.0.52 resets its Codex turn-state in `input` only, so custom-started turns skip that reset. That gap applies to every custom-started Pi turn and belongs to conversion, not this project.
- No compatibility path: historical empty kickoff entries stay as transcript data and need no migration.

## Work Plan

1. Bump all four `@earendil-works/pi-*` dev deps to 1.2.0 (done; 7 fast tests in the admission layer fail).
2. Shrink `session-startup.ts` to the native-start observer (`agent.prompt` wrapper: `beforeStart` fence, `started(signal)`). Drop registry/hook if no longer needed.
3. `NativeSessionDriver`: send custom deliveries through `session.sendCustomMessage` directly, accept synchronously, drop the busy loop. Hold an idle start beside an open native start call (`pending-native-starts.ts`); move the start fence into the driver for both Delivery kinds.
4. Owner/child adapters: drop `captureInputHandoff`, keep the child's forced-handled handoff bookkeeping.
5. Remove tests that pin superseded local behavior. An independent agent writes contract tests for the new path. Update docs (`agent-messaging.md`, `owner-workflow.md` if touched, stale comment in `coordination-tools.ts`).
6. Independent review, then PR closing #140.

## Validation

- Typecheck. Focused fast and process suites covering idle custom startup, child compaction delivery, child lifecycle, Moderator reminder, delivery failure notice, run supervision and agent request.
- Contract: first and settled idle custom Message/Request in Owner and child run `before_agent_start` once per Run, with prepared prompt kept after a tool round trip. Custom fields are kept, there is no empty user entry, and there is exactly one Delivery. Cancellation before native start commits nothing. Active steer/follow-up ordering is unchanged.

## Progress

- [x] Bump deps; record red fast tests.
- [x] Refactor runtime.
- [x] Prune superseded tests; independent contract tests.
- [x] Docs.
- [ ] Review; PR.

## Surprises & Discoveries

- `preflightResult` dispositions are `"handled" | "queued" | "started"`.
- The input-phase race above was found during design, not by a test. Without a gate, an idle human prompt would be dropped.
- The independent contract tests found the settlement deferral: a custom Delivery sent from an `agent_settled` listener got a false commit proof and an early completion. A held attempt must also decide before its proof subscribes, since Pi's in-progress emit delivers `agent_settled` to a listener added mid-emit.
- Gating user Deliveries on the input phase deadlocked native-input forwarding: the forwarded resume replaces the very prompt whose `input` hook awaits it. So only settlement holds user Deliveries.
- run-supervision's failed-Supervisory-Resume test restored transcript access before its Run settled. The Delivery's own entry is now the Run's first message, so the proof rejects mid-Run. Restoring access then let Pi persist the failure as a model error, which suspended the Run. The test now waits for idle first.
- The first independent review found four more gaps, fixed here:
  - A Delivery joining a preparing start was stranded in agent-core's queue when that start's fence failed it. Agent-core never ran, so its proof never settled. Every driver Delivery now waits for the driver's own preparing custom start to reach native start.
  - A proof unsubscribed synchronously inside Pi's `_emit`. Pi walks its live listener array, so the next listener missed that event; two proofs settling on one `agent_settled` hung the second. The unsubscribe is now deferred to a microtask. Predates this change.
  - A held-open extension command, such as the `/agents` selector, counted as an input phase. Commands run before input and start no Run, so they are no longer tracked.
  - A start fence stayed armed after a submission that started no Run; it is now spent then.
- The second review found the joiner hold incomplete:
  - It was per driver and custom-only, so a cancelled user start, or another driver generation on the same session, still stranded joiners.
  - It released before a failing fence threw, so joiners were only safe if Pi settled within a couple of microtasks.
  - Dispose removed the start observer, so a Delivery still preparing then committed while its proof reported `native_session_driver_disposed`.
  - Fixed: the hold now lives on the session-wide `PendingNativeStarts`, covers user starts once the session is busy, and releases on fence pass or call return. The driver keeps its observer until its in-flight submissions return.
  - A narrow third review: a failed fence now releases at Pi's `agent_settled` rather than call return, so joiners can join a Run Pi starts from that settlement. A submission now counts as in flight as soon as Pi has it.
  - Theoretical, left as is: a user Delivery submitted mid-Run takes no hold if that Run ends during its input phase. The child admission gate already keeps other Deliveries out until a user start's preflight, and the Owner fence fails only on dispose.
  - Accepted constraint: a `before_agent_start` hook must not await a Delivery to its own session, which would wait on the fence the hook blocks. No hook here does.
  - Still open, as before this change: a synchronous unsubscribe inside a session listener in the child compaction gateway (follow-up), and non-driver input queued during a fenced start's preparation, which waits for the next Run.
- Review notes left as they were: a reminder that reads busy during a child input phase ending `handled` waits for the next drain edge, as with the old `isPreparing`. A fenced Run loses its `nextTurn` and handler messages, as with the old `agent.prompt` fence.
- A Moderator reminder reads busy while a call is settling. That cannot strand it: the Owner hears the settlement over IPC, and the open call closes within microtasks of that emit.

## Decisions

- Drop `input` emulation for custom deliveries. Rejected: keeping the empty kickoff only to fire `input`. It would keep the whole admission layer alive just to contradict upstream's documented split between input processing and run preparation.
- Keep the `agent.prompt` start fence. Rejected: relying on `session.abort()` during setup. It commits the cancelled Delivery into an aborted Run.
- Attribute the fence to its submission with AsyncLocalStorage, in the driver, for both kinds. Rejected: a child-only fence, which missed Owner and user Deliveries cancelled in their input phase.
- Fail a custom start during compaction fast (`custom_start_during_compaction`). Rejected: letting Pi start it beside compaction.
- Hold idle starts beside an open native call, retrying at each phase change. Rejected: detecting a deferral after the fact. By then the deferred Run starts outside the fence and the proof's window.

## Outcomes & Retrospective

- Removed `session-startup.ts`: the kickoff prompt, injection hook, busy admission, reload retention and handoff release.
- Added `native-run-start.ts` (start fence and signal) and `pending-native-starts.ts` (input-phase and settlement holds).
- Custom deliveries no longer run `input` handlers. The pi-codex-conversion turn-state reset gap is upstream's to close.
