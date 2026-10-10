import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { OwnerRecoveryError } from "../src/bootstrap/owner-recovery-error.ts";
import { registerAgentsCommand, type AgentsCommandRole } from "../src/tools/agents-command.ts";

const ownerStatus = {
	agentId: "owner",
	workflowId: "owner",
	label: "Owner",
	directSpawnerAgentId: null,
	primaryEvidence: {
		transcriptPath: "/sessions/owner.jsonl",
		inspectedThrough: { agentId: "owner", entryId: "owner-entry" },
	},
	run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
	model: { provider: "provider", modelId: "model" },
	thinking: "high",
	compacting: false,
	queuedInputCount: 0,
} as const;
const childStatus = { ...ownerStatus, agentId: "child", label: "Child", directSpawnerAgentId: "owner" } as const;

type CapturedCommand = Readonly<{
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => unknown;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}>;

function captureCommand(role: AgentsCommandRole): CapturedCommand {
	let command: CapturedCommand | undefined;
	registerAgentsCommand({
		registerCommand(_name: string, options: CapturedCommand) {
			command = options;
		},
	} as unknown as ExtensionAPI, role);
	assert.ok(command);
	return command;
}

/** Records every Owner-side effect a registrar could cause. */
function recordingRoles() {
	const effects: string[] = [];
	const presentation = {
		async snapshot() {
			effects.push("snapshot");
			return {
				live: [ownerStatus, childStatus], dormant: [], selectedAgentId: "child",
				humanAttention: [], operationalAttention: [], reports: [],
			};
		},
		async setReportRead() { effects.push("read"); },
		async select(action: { kind: string; agentId?: string }) {
			effects.push(`select ${action.agentId}`);
			return { kind: "selected" as const };
		},
		addChangeHandler() {
			effects.push("subscribe");
			return () => undefined;
		},
	};
	const view = () => {
		effects.push("view");
		return {} as OrdinaryAgentCoordinatorView;
	};
	const roles = {
		participant: { kind: "participant", presentation },
		admitted_owner: { kind: "admitted_owner", view, tools: { refreshSpawnGuidance() {} }, syncVirtualModels: async () => {} },
		blocked_owner: { kind: "blocked_owner", failure: new OwnerRecoveryError("admission", "owner", undefined, new Error("admission failed")) },
	} as const satisfies Record<string, AgentsCommandRole>;
	return { effects, roles };
}

function notifyingContext(mode: "tui" | "rpc") {
	const notifications: Readonly<{ message: string; type?: string }>[] = [];
	const ctx = {
		mode,
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			custom() { throw new Error("no surface may open"); },
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

const completionValues = (command: CapturedCommand, prefix: string) =>
	(command.getArgumentCompletions?.(prefix) as { value: string }[] | null)?.map(({ value }) => value) ?? null;

test("completions and usage list exactly the subcommands each mode offers", async () => {
	const { roles } = recordingRoles();
	const expected = {
		participant: { subcommands: ["owner"], usage: "Usage: /agents [owner]" },
		admitted_owner: { subcommands: ["owner", "diagnostics", "models"], usage: "Usage: /agents [owner|diagnostics|models]" },
		blocked_owner: { subcommands: ["diagnostics"], usage: "Usage: /agents [diagnostics]" },
	} as const;
	for (const kind of ["participant", "admitted_owner", "blocked_owner"] as const) {
		const command = captureCommand(roles[kind]);
		assert.deepEqual(completionValues(command, ""), expected[kind].subcommands, kind);
		assert.deepEqual(completionValues(command, "x"), null, kind);
		await assert.rejects(
			command.handler(" teammate ", notifyingContext("tui").ctx),
			(error: unknown) => error instanceof Error && error.message === expected[kind].usage,
			kind,
		);
	}
	assert.deepEqual(completionValues(captureCommand(roles.admitted_owner), "m"), ["models"]);
});

test("unsupported arguments are rejected before any snapshot, view, or selection", async () => {
	const { effects, roles } = recordingRoles();
	for (const role of Object.values(roles)) {
		for (const argument of ["teammate", "owner extra"]) {
			await assert.rejects(captureCommand(role).handler(argument, notifyingContext("tui").ctx), /^Error: Usage/);
		}
	}
	// A blocked Owner has no navigation, so `owner` is unsupported there too.
	await assert.rejects(captureCommand(roles.blocked_owner).handler("owner", notifyingContext("tui").ctx), /Usage: \/agents \[diagnostics\]/);
	assert.deepEqual(effects, []);
});

test("headless sessions explain that /agents surfaces need the terminal UI", async () => {
	const { effects, roles } = recordingRoles();
	for (const role of [roles.participant, roles.admitted_owner, roles.blocked_owner]) {
		const { ctx, notifications } = notifyingContext("rpc");
		await captureCommand(role).handler("", ctx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /need Pi's terminal UI/);
		assert.equal(notifications[0]!.type, "warning");
	}
	assert.deepEqual(effects, []);
});

test("a blocked Owner points navigation to diagnostics and keeps diagnostics available", async () => {
	const { roles } = recordingRoles();
	const command = captureCommand(roles.blocked_owner);
	const { ctx, notifications } = notifyingContext("tui");
	await command.handler("", ctx);
	assert.deepEqual(notifications, [{
		message: "Subagent coordination is unavailable. Use /agents diagnostics.", type: "warning",
	}]);

	const headless = notifyingContext("rpc");
	await command.handler("diagnostics", headless.ctx);
	assert.match(headless.notifications[0]!.message, /Subagent coordination blocked/);
	assert.equal(headless.notifications[0]!.type, "error");
});

test("a participant returns to the Owner over Control without opening the selector", async () => {
	const { effects, roles } = recordingRoles();

	await captureCommand(roles.participant).handler(" owner ", notifyingContext("tui").ctx);

	assert.deepEqual(effects, ["snapshot", "select owner"]);
});

test("the Owner's Config saves through the view, re-registers Virtual Models, and Escape reopens the selector", { timeout: 5_000 }, async () => {
	const effects: string[] = [];
	const config = {
		availableModels: [{ provider: "openai-codex", modelId: "gpt-6-astra", name: "Astra" }],
		excludedModels: [],
		virtualModels: { fast: [{ model: { provider: "openai-codex", modelId: "gpt-6-astra" }, thinking: "high" as const }] },
	};
	const view = {
		status: () => childStatus,
		selectionRoster: () => ({ live: [ownerStatus, childStatus], dormant: [], quarantined: [], quarantinedCandidateCount: 0 }),
		humanAttention: () => [],
		operationalAttention: () => [],
		reportHistory: () => [],
		setReportRead: () => undefined,
		addAgentActivityChangeHandler: () => () => undefined,
		agentTemplateSnapshot: () => ({}),
		async virtualModelConfig() {
			effects.push("read config");
			return config;
		},
		async setVirtualModels(definitions: Record<string, unknown>) {
			effects.push(`save ${JSON.stringify(Object.keys(definitions))}`);
			return { ...config, virtualModels: definitions };
		},
	} as unknown as OrdinaryAgentCoordinatorView;
	const role: AgentsCommandRole = {
		kind: "admitted_owner",
		view: () => view,
		tools: { refreshSpawnGuidance() { effects.push("refresh guidance"); } },
		async syncVirtualModels() { effects.push("sync"); },
	};
	const steps: SurfaceStep[] = [
		async (press) => press("c"),
		async (press, text) => {
			assert.match(text(), /Virtual Models/);
			await press("d", "d");
			assert.doesNotMatch(text(), /fast/);
			await press("\x1b");
		},
		async (press, text) => {
			assert.match(text(), /Config \[c\]/);
			await press("\x1b");
		},
	];
	const { ctx, surfaces } = scriptedCommandContext(steps, effects);

	await captureCommand(role).handler("", ctx);

	assert.deepEqual(surfaces, ["surface 1", "surface 2", "surface 3"]);
	assert.deepEqual(effects.filter((effect) => effect !== "refresh guidance"), ["read config", "save []", "sync"]);
});

/**
 * An Owner whose Config opens `editorCommand` on a policy file that does not exist
 * yet, in a `config/` directory that does not exist either, as on a fresh install.
 */
function ownerWithPolicyFile(editorCommand: string, effects: string[]) {
	const directory = mkdtempSync(join(tmpdir(), "agents-command-editor-"));
	const policyPath = join(directory, "config", "pi-durable-subagents.json");
	const config = {
		availableModels: [{ provider: "openai-codex", modelId: "gpt-6-astra", name: "Astra" }],
		excludedModels: [],
		virtualModels: { fast: [{ model: { provider: "openai-codex", modelId: "gpt-6-astra" }, thinking: "high" as const }] },
	};
	const view = {
		status: () => childStatus,
		selectionRoster: () => ({ live: [ownerStatus, childStatus], dormant: [], quarantined: [], quarantinedCandidateCount: 0 }),
		humanAttention: () => [],
		operationalAttention: () => [],
		reportHistory: () => [],
		setReportRead: () => undefined,
		addAgentActivityChangeHandler: () => () => undefined,
		agentTemplateSnapshot: () => ({}),
		async virtualModelConfig() { return config; },
		async setVirtualModels() { throw new Error("hand edits must not save through Config"); },
		workflowPolicyFile: () => ({ path: policyPath, editorCommand }),
		async reloadWorkflowPolicy() {
			const saved = readFileSync(policyPath, "utf8");
			effects.push(`reload ${saved.trim()}`);
			return { ...config, virtualModels: saved.includes("review") ? { review: config.virtualModels.fast } : {} };
		},
	} as unknown as OrdinaryAgentCoordinatorView;
	const role: AgentsCommandRole = {
		kind: "admitted_owner",
		view: () => view,
		tools: { refreshSpawnGuidance() {} },
		async syncVirtualModels() { effects.push("sync"); },
	};
	return { directory, policyPath, role };
}

/** Opens Config, presses e, checks the result, then leaves Config and the selector. */
function editInConfig(check: (text: string) => void): SurfaceStep[] {
	return [
		async (press) => press("c"),
		async (press, text) => {
			await press("e");
			// The editor is a real child process; give it time to exit and the reload to land.
			for (let attempt = 0; attempt < 200 && !/review|exited|Could not start/u.test(text()); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			check(text());
			await press("\x1b");
		},
		async (press) => press("\x1b"),
	];
}

test("e in the Owner's Config runs Pi's editor on the policy file, then reloads it and re-registers Virtual Models", { timeout: 5_000 }, async () => {
	const effects: string[] = [];
	const scripts = mkdtempSync(join(tmpdir(), "agents-command-editor-script-"));
	const script = join(scripts, "editor.sh");
	// Records its arguments so the test sees the configured flag kept before the path.
	writeFileSync(script, `printf '{"virtualModels":{"review":[]}}' > "$2"\necho "$1" > "$2.args"\n`);
	const { policyPath, role } = ownerWithPolicyFile(`sh ${script} --wait`, effects);
	const { ctx } = scriptedCommandContext(editInConfig((text) => {
		assert.match(text, /review/);
		assert.doesNotMatch(text, /fast/);
	}), effects);

	await captureCommand(role).handler("", ctx);

	assert.equal(readFileSync(`${policyPath}.args`, "utf8").trim(), "--wait");
	assert.deepEqual(effects, ["tui stop", 'reload {"virtualModels":{"review":[]}}', "sync", "tui start"]);
});

test("an editor that fails to start or exits non-zero reloads nothing and Config shows why", { timeout: 5_000 }, async () => {
	for (const [editorCommand, expected] of [
		["false", /Editor "false" exited with code 1/],
		["pi-durable-subagents-no-such-editor --wait", /Could not start editor "pi-durable-subagents-no-such-editor --wait"/],
	] as const) {
		const effects: string[] = [];
		const { role } = ownerWithPolicyFile(editorCommand, effects);
		const { ctx } = scriptedCommandContext(editInConfig((text) => {
			assert.match(text, expected);
			assert.match(text, /fast/, "Config keeps what it showed before the editor");
		}), effects);

		await captureCommand(role).handler("", ctx);

		assert.deepEqual(effects, ["tui stop", "tui start"], editorCommand);
	}
});

test("a child's /agents selector offers no Config", { timeout: 5_000 }, async () => {
	const { roles } = recordingRoles();
	const { ctx, surfaces } = scriptedCommandContext([
		async (press, text) => {
			assert.doesNotMatch(text(), /Config/);
			await press("c");
			assert.match(text(), /Live/, "c must leave the selector open");
			await press("\x1b");
		},
	], []);

	await captureCommand(roles.participant).handler("", ctx);

	assert.deepEqual(surfaces, ["surface 1"]);
});

type SurfaceStep = (press: (...keys: string[]) => Promise<void>, text: () => string) => Promise<void>;

/** A TUI command context whose surfaces each run one scripted step; extra surfaces fail. */
function scriptedCommandContext(steps: readonly SurfaceStep[], effects: string[]) {
	const surfaces: string[] = [];
	const ctx = {
		mode: "tui",
		shutdown() {},
		ui: {
			notify(message: string) { effects.push(`notify ${message}`); },
			custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: T) => void) => {
				handleInput?(data: string): void;
				render(width: number): string[];
			}) {
				const step = steps[surfaces.length];
				surfaces.push(`surface ${surfaces.length + 1}`);
				return new Promise<T>((resolve, reject) => {
					const component = factory(
						{
							terminal: { rows: 40 },
							requestRender() {},
							stop() { effects.push("tui stop"); },
							start() { effects.push("tui start"); },
						},
						{ fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, getBgAnsi: () => "", bold: (text: string) => text },
						{},
						resolve,
					);
					if (!step) {
						reject(new Error(`unexpected surface ${surfaces.length}`));
						return;
					}
					const press = async (...keys: string[]) => {
						for (const key of keys) {
							component.handleInput?.(key);
							await new Promise<void>((done) => setImmediate(done));
						}
					};
					void step(press, () => component.render(100).join("\n")).catch(reject);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, surfaces };
}
