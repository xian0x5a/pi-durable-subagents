import { spawnSync } from "node:child_process";

/** Sizes the fixture's PTY to the emulator dimensions its test requested, if any. */
export function applyRequestedPtySize(): void {
	const requestedColumns = Number(process.env.PTY_TEST_COLUMNS);
	const requestedRows = Number(process.env.PTY_TEST_ROWS);
	if (
		!Number.isInteger(requestedColumns) || requestedColumns <= 0 ||
		!Number.isInteger(requestedRows) || requestedRows <= 0
	) return;
	const resized = spawnSync(
		"stty",
		["cols", String(requestedColumns), "rows", String(requestedRows)],
		{ stdio: "inherit" },
	);
	if (resized.status !== 0) throw new Error("PTY fixture could not resize its terminal");
}
