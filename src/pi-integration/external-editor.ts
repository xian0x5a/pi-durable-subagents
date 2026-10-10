import { spawn } from "node:child_process";

/**
 * Opens `path` in the editor command Pi resolves for Ctrl+G and resolves when it
 * exits cleanly. The caller owns the terminal: stop the TUI before, restart after.
 */
export async function editFileInExternalEditor(command: string, path: string): Promise<void> {
	// Pi splits its configured command the same way, so `code --wait` works here too.
	const [editor, ...editorArguments] = command.split(" ");
	// Async spawn, as in Pi: on Windows a synchronous child keeps Node's console read
	// active and races the editor for input.
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		const child = spawn(editor!, [...editorArguments, path], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", (error) => reject(new Error(`Could not start editor "${command}": ${error.message}`)));
		child.on("close", resolve);
	});
	if (exitCode !== 0) throw new Error(`Editor "${command}" exited with code ${exitCode}`);
}
