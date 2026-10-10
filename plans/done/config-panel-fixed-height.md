# Fixed height for the Config and `/agents models` panels

Follow-up to #225 and #226.

## Goal

The Config panel and `/agents models` keep one height while you move between screens, search, or see a status, like the `/agents` selector. Only a terminal resize changes it.

## Intention

User's words: "the height implementation should be similar to /agents menu". The centered panels re-centered on every height change, so they jumped up and down. The Config list and definition screens drew every row, so with many names they ran past the height cap and clipped the help line.

## Design

- Shared panel geometry in `src/presentation/overlay-frame.ts`, used by the selector, Config, and `/agents models`: overlay width, margin, and height cap, plus the terminal-bounded row budget the selector already used.
- A shared centered scroll window (the `SelectList` rule: focus centered, `(i/n)` indicator when rows overflow), replacing the copy in `/agents models`.
- Config:
  - Body budget: the tallest screen (model picker: search, gap, 8 rows, indicator), capped by the terminal.
  - Every screen is padded to the budget. One status row is always reserved.
  - The list and definition screens scroll. The focused name's detail block is capped and drops first on short terminals.
  - The pickers rebuild on resize so their visible rows follow the budget.
  - The invalid-file notice is fixed for the panel's lifetime (no saves while invalid), so it only shifts the budget, not the height.
- `/agents models`: rows window padded to its budget; status and model-name rows always reserved.

## Scope & Constraints

- No change to keys, actions, or saving.
- Selector behavior unchanged; it only reads the shared constants.

## Validation

- `npm run typecheck`; focused `test:fast` for the three surfaces.
- Independent blind tests from the user's words and public interfaces, then an independent review.

## Progress

- [x] Shared geometry and scroll window.
- [x] Config fixed height (throwaway render: every screen 19 rows at 40 terminal rows, 12 at 14, follows a resize).
- [x] `/agents models` fixed height (20 rows at 40 terminal rows across searches and no matches).
- [x] Docs.
- [x] Independent review: short terminals overflowed the overlay bound, the 12-row model picker showed no rows, `/agents models` reserved one row too many, and the scroll-indicator constant was duplicated. All fixed (f3da71c) by sharing the selector's short-terminal fit.
- [x] Independent blind tests (256dbc9): fail on 51d92eb, pass after f3da71c.

## Decisions

- Centered stateless scroll window (`SelectList` rule) rather than the selector's stateful keep/center offset: Config and `/agents models` already center, and neither has pointer scrolling to keep stable.

## Surprises & Discoveries

- A fixed body budget alone is not enough: below about 13 terminal rows the fixed rows around the body exceed pi-tui's overlay bound (`floor(rows × 90%)`, capped at `rows − 2`), and pi-tui cuts the bottom, help included. The selector already handled this with its short-terminal fit, now shared.

## Outcomes & Retrospective

- Config and `/agents models` keep one terminal-bounded height per session, like the selector; only a resize changes it. Long Config lists scroll around the focus.
- All three panels share overlay geometry, the centered scroll window, and the short-terminal fit in `src/presentation/overlay-frame.ts`.
- The read-only Config view is two rows taller than the editable one (its invalid-file notice). Validity cannot change while the panel is open, so its height is still fixed for the session.
- At 10 terminal rows or fewer the focused row can be clipped, as in the selector.
- Lesson: probe the smallest terminals before review, not only the typical ones.
