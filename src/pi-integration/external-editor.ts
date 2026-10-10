import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Opens `path` in the editor command Pi resolves for Ctrl+G and resolves when it
 * exits cleanly. The caller owns the terminal: stop the TUI before, restart after.
 */
export async function editFileInExternalEditor(command: string, path: string): Promise<void> {
	// Editors open a missing file as new but cannot save it into a missing directory.
	await mkdir(dirname(path), { recursive: true });
	// Pi splits its configured command the same way, so `code --wait` works here too.
	const [editor, ...editorArguments] = command.split(" ");
	// A GUI editor leaves the stopped TUI frozen, so say what Pi is waiting for, as Pi does.
	process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);
	// Async spawn, as in Pi: on Windows a synchronous child keeps Node's console read
	// active and races the editor for input.
	const exit = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
		const child = spawn(editor!, [...editorArguments, path], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", (error) => reject(new Error(`Could not start editor "${command}": ${error.message}`)));
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
	if (exit.signal !== null) throw new Error(`Editor "${command}" was stopped by ${exit.signal}`);
	if (exit.code !== 0) throw new Error(`Editor "${command}" exited with code ${exit.code}`);
}
