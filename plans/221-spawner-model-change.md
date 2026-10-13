---
status: done
---

# Spawner changes a child's model and thinking

Issue: #221. Builds on #220 / PR #222 (sticky selection, ADR 0009) and #216 (Virtual Models, preset thinking).

## Goal

The Owner, a child's Direct Spawner, or a Moderator (the existing `agent_control` authority) can change a child Agent's model and thinking after spawn with the same `{ id, thinking }` pair as `agent_spawn.config.model`. A live child switches without losing context; a child without a Runtime records the selection so its next Runtime starts on it.

## Intention

User's words (issue): "A Spawner that sees a child struggling (too weak a model, too little thinking) or overspending has no option except spawning a replacement, which loses the child's context."

## Design

- **Surface:** a new `agent_control` operation `set_model { agentId, model: { id, thinking } }` (ADR 0006: one tool per coordination concern; run supervision already owns "act on a child's Run"). Same schema fragment as `agent_spawn.config.model`, both fields required.
- **Authority:** unchanged `#requireControllableTarget` (Owner, Direct Spawner, Moderator; never the Owner or self).
- **Validation = spawn:** the Owner-side factory resolves the pair with the same code as spawn's initial model resolution (availability, `excludedModels`, `virtual/<name>` + `preset`, clamp). `inherit` keeps its spawn meaning: the target's Direct Spawner's current selection, captured now. Result is a `RecordedModelSelection` with the effective level.
- **Routing inside the target's host lane:**
  - Runtime process exists (admitted, prepared, or retained): Control request `model.select` to the child (protocol 14 → 15). Writing the file of a session that has a process would fork its tree.
  - No Runtime: open the session file and `recordModelSelection` (same as the #220 fallback). The lane blocks a concurrent start.
- **Live apply (child):** inside the turn-admission lane (as `run.interrupt`), `setModel` + `setThinkingLevel`, then append the Virtual Model mode state (`preset`/`explicit`). Pi reads the model per provider request, so an in-flight request finishes on the old model and the next one uses the new one; this is the same boundary as a user's `/model` during streaming. Native footer and Runtime snapshot update through Pi's existing select events.
- **Preset heuristic:** a select event ends preset mode only when a `model_change`/`thinking_level_change` follows the latest mode-state entry for that model. A manual change always appends such an entry; a Spawner change writes its mode state last, so a late (un-awaited) `thinking_level_select` handler sees no later change and leaves it alone. No suppression flag.
- **Receipt:** `{ agentId, disposition: "applied" | "recorded", model: { id, thinking }, thinkingLevel }` — `thinking` is the selection (`inherit` resolved, explicit level clamped, `preset` kept), `thinkingLevel` the level the next request runs.
- **Evidence:** no new entry type. The caller's `agent_control` call + receipt says who changed what; the child's session holds Pi's native `model_change` / `thinking_level_change` / mode state, which cold recovery already reads (ADR 0009).

## Decision: where the operation lives

| Criterion (weight) | `agent_control` op | new tool |
|---|---|---|
| Fits ADR 0006 / role surface (40%) | 5 | 2 |
| Reuses authority + replay + renderers (35%) | 5 | 2 |
| Model-facing clarity (25%) | 4 | 5 |
| **Total** | **4.75** | **2.75** |

## Scope & Constraints

- Only model and thinking. Nothing persisted to user settings (ADR 0001).
- `InProcessHostedRuntime` (Owner) rejects; the Owner is never a target.

## Work Plan

1. Extract the model part of `resolveAgentRunConfiguration` into a reusable resolver; factory exposes `resolveModelChange(record, pair)`.
2. Protocol: `RunControlInput` / receipt / validator / replay / schemas; catalogue entry, prompt guide, renderer.
3. Control protocol 15: `model.select` owner→child; `HostedAgentRuntime.selectModel`; child handler; bridge heuristic.
4. `RunSupervisor` routing (live vs record) and receipt.
5. Docs: `docs/run-supervision.md`, `docs/agent-spawning.md#model-selection`, `docs/workflow-policy.md` (preset), GLOSSARY, README, ADR 0009 consequence.
6. Independent blind tests, then independent review. Search protocol-version fixtures.

## Validation

- `npm run typecheck`; focused `test:fast` / `test:process` files (run-supervision, sticky-model-selection, virtual-models, coordination-tool-catalogue, control-schema-conformance, coordination-replay-rejection, child-control-connection).

## Progress

- [x] Investigation and design.
- [x] Implementation and docs (9cdf22a). Focused fast/process tests pass; protocol-version fixtures updated (14 → 15).
- [x] Independent blind tests (db96cd9): 7 process tests in `tests/spawner-model-change.test.ts`, all pass, no defect found.
- [x] Independent review: no blocking bugs; fixes for a lane stall behind passive startup UI, a stale roster after `recorded`, and an eager parent lookup.

## Decisions

- Moderators keep `agent_control` authority for `set_model` (issue: "same authority as `agent_control`").
- `inherit` = the target's Direct Spawner's current selection, captured at change time.
- No deferral to `turn_end`: Pi already applies a model change at the next provider request, which is the safe boundary.

## Surprises & Discoveries

- `observe()` reports `dormant` for a prepared or retained Runtime that is not admitted, so routing uses Runtime existence, not phase.
- Pi's `setThinkingLevel` emits `thinking_level_select` without awaiting, so a boolean suppression flag would race.
- A spawn caches its first preparation; launching it after a `set_model` on a queued child would pass the old `--model`. The first preparation is now used only while it still matches the recorded selection.
- Pi itself lets `/model` change the model while streaming; the in-flight request keeps its model. So the "safe boundary" is Pi's own, with no deferral needed.

## Outcomes & Retrospective

- `agent_control` `set_model` lets a supervisor change a child's model and thinking without replacing it. Durable behavior lives in `docs/run-supervision.md#change-a-childs-model`, `docs/agent-spawning.md#model-selection`, and ADR 0009's consequences.
- Review-driven limits, documented: a Runtime still behind passive startup UI rejects with `agent_starting` instead of holding the lane; a Runtime whose process just ended may report an error until failure cleanup makes it Dormant.
- Known nit left as is: `set_model` validation errors reuse the "Agent Spawn config.model" wording of the shared validator.
- Retrospective: the queued-child cache bug and the un-awaited Pi event were both found by reading Pi and the spawn path before coding, not by tests; the blind tests then confirmed them.
