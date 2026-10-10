---
status: done
---

# Open the policy file from the Config tab

Parent: #213 (Config tab for all settings).

## Goal

In the `/agents` Config tab, `e` opens `<agentDir>/config/pi-durable-subagents.json` in the user's external editor. When the editor exits, Config shows the file as saved.

## Intention

User's words: "add a keybinding for opening the config file in default editor? via pressing e". The editor handles every field the Config tab does not edit yet, and it fixes an invalid file, which turns Config read-only.

## Design

- Key: `e` on the Virtual Models list screen, also while the file is invalid. Help line advertises it.
- Editor command: Pi's own resolution, `settingsManager.getExternalEditorCommand()` on the Owner runtime (Pi `externalEditor` setting, then `$VISUAL`, `$EDITOR`, then `nano`/`notepad`). The same editor Pi opens for `Ctrl+G`.
- Launch: stop the TUI, spawn the editor on the real file with inherited stdio (async `spawn`, as Pi does), restart the TUI and force a full redraw. A missing file opens as a new file.
- After a zero exit, the Owner reloads the policy file: a valid file publishes one complete snapshot (same as Owner resource reload), refreshes Template snapshots, and re-syncs the Owner's Virtual Model registrations. An invalid file publishes nothing; Config shows the parse error read-only, as today.
- A spawn failure, non-zero exit, or signal reloads nothing and shows the error in Config's status row.
- The launcher creates the policy directory first: editors cannot save a new file into a missing `config/` (found by the independent tests).
- A published reload rechecks deferred boots, so a raised `maxConcurrentAgentRuns` starts queued children at once (found in review).

## Out of scope

- Moving `/agents models` into Config (#213).
- Watching the file for changes made outside Config.

## Progress

- [x] Implementation
- [x] Independent tests (surface and `/agents` command layers; coordinator reload has no fast-suite harness)
- [x] Independent review (no blockers; fixed the boot recheck and nits)
- [x] Docs

## Follow-ups

- Restart the TUI as soon as the editor exits, before the reload and re-sync. Today keystrokes typed during a slow reload echo to the cooked terminal.
