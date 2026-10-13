import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { SessionManager, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { executeRegisteredTool } from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";
import {
	createProcessModelBroker,
	type ProcessModelBroker,
} from "./support/process-model-broker.ts";

// Black-box tests for issue #221: the Owner or a child's Direct Spawner changes that
// child's model and thinking after spawn through agent_control "set_model".

const TEST_TIMEOUT_MS = 90_000;
const MAX_CONDITION_POLL_ATTEMPTS = 10_000;

// Process-visible providers. The Owner runs on OWNER; children start on INITIAL
// through their Spawn config; CHANGED is the target of a Spawner's change.
const OWNER = { provider: "coordination-test", modelId: "deterministic-owner" };
const INITIAL = { provider: "change-initial", modelId: "initial-model" };
const CHANGED = { provider: "change-target", modelId: "changed-model" };
type ModelRef = { provider: string; modelId: string };
const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

const SWITCH_TOOL = "switch_selection";
const NOOP_TOOL = "noop_step";

type ObservedRequest = { model: string; reasoning: string | undefined; input: string };
type ScriptedCall = { tool: string; args: Record<string, unknown> };

type Fixture = {
	brokers: ProcessModelBroker[];
	extensionPath: string;
	startLogPath: string;
	requests: ObservedRequest[];
	/** `CALL[name]` in an Agent's input makes it call the named tool. */
	calls: Map<string, ScriptedCall>;
	/** `HOLD[name]` in an Agent's input blocks that model request until released. */
	release(name: string): void;
};

type Gate = { promise: Promise<void>; resolve(): void };

/**
 * Scripted model behavior shared by every provider:
 * - after a tool result: a plain "Done after <tool>." answer;
 * - `HOLD[name]`: blocks until the test releases it, then calls the no-op tool, so the
 *   same Run makes a second model request;
 * - `SWITCH[steps]`: a real Pi model/thinking change inside the Agent (as `/model` does);
 * - `CALL[name]`: a scripted coordination tool call;
 * - anything else: "Ack.".
 */
async function scriptedResponse(
	fixture: Pick<Fixture, "requests" | "calls">,
	gate: (name: string) => Gate,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	model: Model<string>,
): Promise<AssistantMessage> {
	const { requests, calls } = fixture;
	const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
	const input = JSON.stringify(context.messages.slice(lastAssistant + 1));
	requests.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning, input });
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") return fauxAssistantMessage(`Done after ${last.toolName}.`);
	const hold = /HOLD\[([\w-]+)\]/.exec(input)?.[1];
	if (hold !== undefined) {
		await gate(hold).promise;
		return fauxAssistantMessage(
			fauxToolCall(NOOP_TOOL, {}, { id: `noop-${requests.length}` }),
			{ stopReason: "toolUse" },
		);
	}
	const switchSteps = /SWITCH\[([^\]]*)\]/.exec(input)?.[1];
	if (switchSteps !== undefined) {
		return fauxAssistantMessage(
			fauxToolCall(SWITCH_TOOL, { steps: switchSteps }, { id: `switch-${requests.length}` }),
			{ stopReason: "toolUse" },
		);
	}
	const callName = /CALL\[([\w-]+)\]/.exec(input)?.[1];
	if (callName !== undefined) {
		const call = calls.get(callName);
		if (!call) throw new Error(`No scripted call ${callName}`);
		return fauxAssistantMessage(
			fauxToolCall(call.tool, call.args as JsonObject, { id: `call-${callName}` }),
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage("Ack.");
}

// Also logs each Runtime start per session, so a test can prove a Runtime is fresh.
const extensionSource = (startLogPath: string) => `
import { appendFileSync } from "node:fs";
export default function spawnerModelChangeFixture(pi) {
  pi.on("session_start", (_event, ctx) => {
    appendFileSync(${JSON.stringify(startLogPath)}, ctx.sessionManager.getSessionId() + "\\n");
  });
  pi.registerTool({
    name: ${JSON.stringify(NOOP_TOOL)},
    label: "No-op step",
    description: "Test-only step that lets a Run make another model request.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "Nothing done." }], details: {} };
    },
  });
  pi.registerTool({
    name: ${JSON.stringify(SWITCH_TOOL)},
    label: "Switch selection",
    description: "Test-only manual model and thinking change.",
    parameters: {
      type: "object",
      properties: { steps: { type: "string" } },
      required: ["steps"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      for (const step of params.steps.split(";")) {
        const [name, value] = step.split("=");
        if (name === "model") {
          const slash = value.indexOf("/");
          const model = ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1));
          if (!model) throw new Error("Unknown model " + value);
          if (!(await pi.setModel(model))) throw new Error("Cannot select " + value);
        } else if (name === "thinking") {
          pi.setThinkingLevel(value);
        } else {
          throw new Error("Unknown step " + step);
        }
      }
      return { content: [{ type: "text", text: "Switched." }], details: {} };
    },
  });
}
`;

async function createFixture(t: TestContext): Promise<Fixture> {
	const requests: ObservedRequest[] = [];
	const calls = new Map<string, ScriptedCall>();
	const gates = new Map<string, Gate>();
	const gate = (name: string): Gate => {
		let existing = gates.get(name);
		if (!existing) {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => { resolve = done; });
			existing = { promise, resolve };
			gates.set(name, existing);
		}
		return existing;
	};
	// Never leave a provider request blocked behind a failed assertion.
	t.after(() => { for (const { resolve } of gates.values()) resolve(); });
	const responseOverride = (context: TranscriptContext, options: SimpleStreamOptions | undefined, model: Model<string>) =>
		scriptedResponse({ requests, calls }, gate, context, options, model);
	const brokers: ProcessModelBroker[] = [];
	for (const model of [OWNER, INITIAL, CHANGED]) {
		const created = await createProcessModelBroker({
			providerId: model.provider,
			modelId: model.modelId,
			modelName: model.modelId,
			responseOverride,
		});
		t.after(() => created.close());
		brokers.push(created);
	}
	const directory = await mkdtemp(join(tmpdir(), "spawner-model-change-"));
	const extensionPath = join(directory, "spawner-model-change-fixture.mjs");
	const startLogPath = join(directory, "runtime-starts.log");
	await writeFile(startLogPath, "", "utf8");
	await writeFile(extensionPath, extensionSource(startLogPath), "utf8");
	return {
		brokers,
		extensionPath,
		startLogPath,
		requests,
		calls,
		release: (name) => gate(name).resolve(),
	};
}

async function openOwner(
	t: TestContext,
	fixture: Fixture,
	options: { previous?: TestOwnerHost; sessionFile?: string; policy?: unknown } = {},
): Promise<TestOwnerHost> {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: false,
		...(options.previous ? {
			cwd: options.previous.cwd,
			agentDir: options.previous.services.agentDir,
			sessionFile: options.sessionFile,
		} : {}),
		// File-backed Owner extensions are inherited by every child process.
		additionalExtensionPaths: [...fixture.brokers.map(({ extensionPath }) => extensionPath), fixture.extensionPath],
	});
	// Workflow Policy is read when the Owner binds.
	if (options.policy !== undefined) await writePolicy(host, options.policy);
	await bindTestOwnerHost(host, "tui");
	return host;
}

async function writePolicy(host: TestOwnerHost, policy: unknown): Promise<void> {
	await mkdir(join(host.services.agentDir, "config"), { recursive: true });
	await writeFile(
		join(host.services.agentDir, "config", "pi-durable-subagents.json"),
		JSON.stringify(policy),
		"utf8",
	);
}

async function executeTool(
	host: TestOwnerHost,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	return (await executeRegisteredTool(host.runtime.session, toolName, toolCallId, input)).details;
}

type SpawnedChild = { agentId: string; sessionFile: string };

/** Spawns a child without waiting for its work. */
async function spawn(
	host: TestOwnerHost,
	toolCallId: string,
	request: string,
	model: { id: string; thinking: string } = { id: key(INITIAL), thinking: "low" },
): Promise<SpawnedChild> {
	const receipt = await executeTool(host, "agent_spawn", toolCallId, {
		title: "Fixture request",
		request,
		config: { model },
	}) as { spawnStatus: string; agentId?: string };
	assert.equal(receipt.spawnStatus, "created", JSON.stringify(receipt));
	const agentId = receipt.agentId!;
	return { agentId, sessionFile: await waitForSessionFile(workflowSessionDirectory(host), agentId) };
}

/** Spawns a child doing plain work and waits for its answer. */
async function spawnSettled(host: TestOwnerHost, toolCallId: string, model?: { id: string; thinking: string }): Promise<SpawnedChild> {
	const child = await spawn(host, toolCallId, `Work for ${toolCallId}.`, model);
	await waitForAssistantText(child.sessionFile, "Ack.");
	return child;
}

function setModel(
	host: TestOwnerHost,
	toolCallId: string,
	agentId: string,
	model: Record<string, unknown>,
): Promise<unknown> {
	return executeTool(host, "agent_control", toolCallId, { operation: "set_model", agentId, model });
}

/** Sends `content` to an Agent and waits until that Agent answered it. */
async function sendAndSettle(host: TestOwnerHost, child: SpawnedChild, toolCallId: string, content: string): Promise<void> {
	await executeTool(host, "agent_message", toolCallId, { operation: "send", targetAgent: child.agentId, content });
	await waitForEntry(child.sessionFile, (entry, index, entries) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.stopReason !== "toolUse" &&
		entries.slice(0, index).some((earlier) => JSON.stringify(earlier).includes(content)));
}

/** Messages an Agent (waking it if dormant) and returns the first model request carrying the marker. */
async function wake(fixture: Fixture, host: TestOwnerHost, child: SpawnedChild, marker = `WAKE-${child.agentId}`): Promise<ObservedRequest> {
	await executeTool(host, "agent_message", `wake-${marker}`, {
		operation: "send",
		targetAgent: child.agentId,
		content: marker,
	});
	const request = await waitForRequest(fixture, marker);
	// Let the woken Run commit its answer before the session is inspected.
	await waitForEntry(child.sessionFile, (entry, index, entries) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entries.slice(0, index).some((earlier) => JSON.stringify(earlier).includes(marker)));
	return request;
}

async function waitForRequest(fixture: Fixture, marker: string): Promise<ObservedRequest> {
	let request: ObservedRequest | undefined;
	await waitForCondition(() => {
		request = fixture.requests.find(({ input }) => input.includes(marker));
		return request !== undefined;
	}, `no model request carried ${marker}`);
	return request!;
}

const selectionOf = (request: ObservedRequest) => ({ model: request.model, reasoning: request.reasoning });

function recordedSelection(sessionFile: string): { model?: string; thinking?: string } {
	const branch = SessionManager.open(sessionFile).getBranch();
	const model = branch.findLast((entry) => entry.type === "model_change");
	const thinking = branch.findLast((entry) => entry.type === "thinking_level_change");
	return {
		...(model?.type === "model_change" ? { model: `${model.provider}/${model.modelId}` } : {}),
		...(thinking?.type === "thinking_level_change" ? { thinking: thinking.thinkingLevel } : {}),
	};
}

async function observeStatus(host: TestOwnerHost, agentId: string): Promise<{ phase: string; work?: string; queued?: boolean }> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const toolCallId = `observe-${agentId}`;
	const status = (await observe.execute(
		toolCallId,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createToolContext(toolCallId, undefined),
	)).details as { run: { phase: string; work?: string; queued?: boolean } };
	return status.run;
}

async function disposeOwner(host: TestOwnerHost): Promise<string> {
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	return ownerSessionFile;
}

async function runtimeStarts(fixture: Fixture, agentId: string): Promise<number> {
	return (await readFile(fixture.startLogPath, "utf8")).split("\n").filter((line) => line === agentId).length;
}

type ToolResultEntry = { toolName: string; isError: boolean; text: string; details: unknown };

function toolResult(sessionFile: string, toolCallId: string): ToolResultEntry | undefined {
	for (const entry of SessionManager.open(sessionFile).getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolCallId !== toolCallId) continue;
		return {
			toolName: entry.message.toolName,
			isError: entry.message.isError,
			text: entry.message.content.map((part) => part.type === "text" ? part.text : "").join(""),
			details: entry.message.details,
		};
	}
	return undefined;
}

async function waitForToolResult(sessionFile: string, toolCallId: string): Promise<ToolResultEntry> {
	let result: ToolResultEntry | undefined;
	await waitForCondition(() => {
		result = toolResult(sessionFile, toolCallId);
		return result !== undefined;
	}, `no tool result ${toolCallId} in ${sessionFile}`);
	return result!;
}

/**
 * A child Spawner P with its own child G, both spawned on INITIAL/low, and a sibling
 * S of P that did not spawn G. P spawns G through its own agent_spawn call.
 */
async function spawnFamily(fixture: Fixture, host: TestOwnerHost) {
	fixture.calls.set("spawn-grandchild", {
		tool: "agent_spawn",
		args: {
			title: "Grandchild request",
			request: "Grandchild work.",
			config: { model: { id: key(INITIAL), thinking: "low" } },
		},
	});
	const parent = await spawn(host, "spawn-family-parent", "CALL[spawn-grandchild]");
	const spawned = await waitForToolResult(parent.sessionFile, "call-spawn-grandchild");
	assert.equal(spawned.isError, false, spawned.text);
	const grandchildId = (spawned.details as { agentId: string }).agentId;
	const grandchild = { agentId: grandchildId, sessionFile: await waitForSessionFile(workflowSessionDirectory(host), grandchildId) };
	await waitForAssistantText(grandchild.sessionFile, "Ack.");
	const sibling = await spawnSettled(host, "spawn-family-sibling");
	return { parent, grandchild, sibling };
}

test("a live child switches at its next model request, and a fresh Runtime keeps the change", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const child = await spawn(host, "spawn-live", "HOLD[live]");
	const held = await waitForRequest(fixture, "HOLD[live]");

	// The change arrives while a model request is in flight.
	const control = setModel(host, "set-live", child.agentId, { id: key(CHANGED), thinking: "high" });
	let receiptBeforeRelease = false;
	void control.then(() => { receiptBeforeRelease = true; }, () => undefined);
	await waitForCondition(() => receiptBeforeRelease, "set_model did not complete while the request was in flight")
		.catch(() => undefined);
	fixture.release("live");
	const receipt = await control;
	await waitForAssistantText(child.sessionFile, `Done after ${NOOP_TOOL}.`);

	assert.deepEqual(selectionOf(held), { model: key(INITIAL), reasoning: "low" }, "the in-flight request finished on the old selection");
	const followUp = fixture.requests.find(({ input }) => input.includes(`"toolName":"${NOOP_TOOL}"`));
	assert.ok(followUp, "the Run made a follow-up request after its tool call");
	assert.deepEqual(
		selectionOf(followUp),
		{ model: key(CHANGED), reasoning: "high" },
		`the next request of the same Run uses the new selection (set_model completed before release: ${receiptBeforeRelease};)`,
	);
	assert.deepEqual(receipt, {
		agentId: child.agentId,
		disposition: "applied",
		model: { id: key(CHANGED), thinking: "high" },
		thinkingLevel: "high",
	});
	assert.deepEqual(recordedSelection(child.sessionFile), { model: key(CHANGED), thinking: "high" });

	await waitForCondition(async () => {
		const status = await observeStatus(host, child.agentId);
		return status.phase === "live" && status.work === "settled";
	}, "child Run did not settle");
	await executeTool(host, "agent_control", "abort-live", { operation: "abort", agentId: child.agentId });
	const successor = await wake(fixture, host, child);
	assert.equal(await runtimeStarts(fixture, child.agentId), 2, "the woken Run started a fresh Runtime");
	assert.deepEqual(selectionOf(successor), { model: key(CHANGED), reasoning: "high" }, "the successor Runtime keeps the change");
	await host.runtime.dispose();
});

test("a dormant child records the change and its next Runtime starts on it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const child = await spawnSettled(host, "spawn-dormant");
	const reopened = await openOwner(t, fixture, { previous: host, sessionFile: await disposeOwner(host) });
	assert.equal((await observeStatus(reopened, child.agentId)).phase, "dormant");

	const receipt = await setModel(reopened, "set-dormant", child.agentId, { id: key(CHANGED), thinking: "medium" });
	assert.deepEqual(receipt, {
		agentId: child.agentId,
		disposition: "recorded",
		model: { id: key(CHANGED), thinking: "medium" },
		thinkingLevel: "medium",
	});
	assert.deepEqual(recordedSelection(child.sessionFile), { model: key(CHANGED), thinking: "medium" });
	assert.equal(await runtimeStarts(fixture, child.agentId), 1, "recording does not start a Runtime");
	const request = await wake(fixture, reopened, child);
	assert.deepEqual(selectionOf(request), { model: key(CHANGED), reasoning: "medium" });
	await reopened.runtime.dispose();
});

test("a queued child that has not started yet starts on the changed selection", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture, { policy: { maxConcurrentAgentRuns: 1 } });
	const blocker = await spawn(host, "spawn-blocker", "HOLD[blocker]");
	await waitForRequest(fixture, "HOLD[blocker]");
	const queued = await spawn(host, "spawn-queued", "Queued work.");
	await waitForCondition(async () => (await observeStatus(host, queued.agentId)).queued === true, "second child was not queued");

	const receipt = await setModel(host, "set-queued", queued.agentId, { id: key(CHANGED), thinking: "high" });
	assert.deepEqual(receipt, {
		agentId: queued.agentId,
		disposition: "recorded",
		model: { id: key(CHANGED), thinking: "high" },
		thinkingLevel: "high",
	});
	assert.equal(fixture.requests.some(({ input }) => input.includes("Queued work.")), false, "the queued child stays queued");
	// Aborting the blocker frees the only slot (a plain reply would still owe an Answer).
	await executeTool(host, "agent_control", "abort-blocker", { operation: "abort", agentId: blocker.agentId });
	fixture.release("blocker");
	const first = await waitForRequest(fixture, "Queued work.");
	assert.deepEqual(selectionOf(first), { model: key(CHANGED), reasoning: "high" });
	await host.runtime.dispose();
});

test("a rejected selection leaves the child's model and thinking untouched", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture, {
		policy: {
			excludedModels: [`${CHANGED.provider}/*`],
			virtualModels: { fast: [{ id: key(INITIAL), thinking: "low" }] },
		},
	});
	const child = await spawnSettled(host, "spawn-rejections");
	const cases = [
		{ name: "excluded model", model: { id: key(CHANGED), thinking: "high" } },
		{ name: "unavailable model", model: { id: "missing-provider/missing-model", thinking: "high" } },
		{ name: "undefined Virtual Model", model: { id: "virtual/undefined", thinking: "high" } },
		{ name: "preset with a non-virtual id", model: { id: key(OWNER), thinking: "preset" } },
		{ name: "preset with inherit id", model: { id: "inherit", thinking: "preset" } },
		{ name: "missing thinking", model: { id: key(OWNER) } },
		{ name: "missing id", model: { thinking: "high" } },
		{ name: "unknown thinking level", model: { id: key(OWNER), thinking: "turbo" } },
		{ name: "extra field", model: { id: key(OWNER), thinking: "high", provider: "x" } },
	];
	for (const [index, { name, model }] of cases.entries()) {
		await assert.rejects(setModel(host, `set-rejected-${index}`, child.agentId, model), Error, name);
		assert.deepEqual(recordedSelection(child.sessionFile), { model: key(INITIAL), thinking: "low" }, name);
	}
	const request = await wake(fixture, host, child);
	assert.deepEqual(selectionOf(request), { model: key(INITIAL), reasoning: "low" });
	await host.runtime.dispose();
});

test("a child's Direct Spawner can change it, but a sibling that did not spawn it cannot", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	const { parent, grandchild, sibling } = await spawnFamily(fixture, host);
	const change = (thinking: string) => ({
		tool: "agent_control",
		args: { operation: "set_model", agentId: grandchild.agentId, model: { id: key(CHANGED), thinking } },
	});

	fixture.calls.set("sibling-set", change("minimal"));
	await sendAndSettle(host, sibling, "sibling-attempt", "CALL[sibling-set]");
	const rejected = await waitForToolResult(sibling.sessionFile, "call-sibling-set");
	assert.equal(rejected.isError, true, rejected.text);
	assert.match(rejected.text, /unauthorized/);
	assert.deepEqual(recordedSelection(grandchild.sessionFile), { model: key(INITIAL), thinking: "low" });

	fixture.calls.set("spawner-set", change("high"));
	await sendAndSettle(host, parent, "spawner-attempt", "CALL[spawner-set]");
	const accepted = await waitForToolResult(parent.sessionFile, "call-spawner-set");
	assert.equal(accepted.isError, false, accepted.text);
	assert.deepEqual(
		(accepted.details as { model: unknown }).model,
		{ id: key(CHANGED), thinking: "high" },
	);
	const request = await wake(fixture, host, grandchild);
	assert.deepEqual(selectionOf(request), { model: key(CHANGED), reasoning: "high" });
	await host.runtime.dispose();
});

test("inherit resolves to the target's parent's current selection", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const fixture = await createFixture(t);
	const host = await openOwner(t, fixture);
	host.session.setThinkingLevel("minimal");
	const { parent, grandchild } = await spawnFamily(fixture, host);
	// The parent's current selection differs from both its spawn config and the Owner's.
	await sendAndSettle(host, parent, "parent-switch", `SWITCH[model=${key(CHANGED)};thinking=medium]`);
	assert.deepEqual(recordedSelection(parent.sessionFile), { model: key(CHANGED), thinking: "medium" });

	const receipt = await setModel(host, "set-inherit", grandchild.agentId, { id: "inherit", thinking: "inherit" }) as {
		model: unknown;
		thinkingLevel: string;
	};
	assert.deepEqual(receipt.model, { id: key(CHANGED), thinking: "medium" });
	assert.equal(receipt.thinkingLevel, "medium");
	const request = await wake(fixture, host, grandchild);
	assert.deepEqual(selectionOf(request), { model: key(CHANGED), reasoning: "medium" });
	await host.runtime.dispose();
});

test("a Spawner's preset thinking stays preset across fresh Runtimes until the child switches thinking", { timeout: TEST_TIMEOUT_MS * 2 }, async (t) => {
	const fixture = await createFixture(t);
	const policy = (level: string) => ({ virtualModels: { fast: [{ id: key(INITIAL), thinking: level }] } });
	const preset = { id: "virtual/fast", thinking: "preset" };
	const host = await openOwner(t, fixture, { policy: policy("low") });
	// Children start explicit on OWNER, so the preset level is distinguishable.
	const startOn = { id: key(OWNER), thinking: "medium" };
	const livePreset = await spawnSettled(host, "spawn-preset-live", startOn);
	const thenManual = await spawnSettled(host, "spawn-preset-manual", startOn);
	const dormantPreset = await spawnSettled(host, "spawn-preset-dormant", startOn);

	const receipt = await setModel(host, "set-preset-live", livePreset.agentId, preset);
	assert.deepEqual(receipt, {
		agentId: livePreset.agentId,
		disposition: "applied",
		model: preset,
		thinkingLevel: "low",
	});
	const live = await wake(fixture, host, livePreset, "LIVE-PRESET");
	assert.deepEqual(selectionOf(live), { model: key(INITIAL), reasoning: "low" }, "the live child routes through the Virtual Model");
	await setModel(host, "set-preset-manual", thenManual.agentId, preset);
	await sendAndSettle(host, thenManual, "manual-thinking", "SWITCH[thinking=minimal]");

	// The dormant path records preset mode without a Runtime.
	const reopened = await openOwner(t, fixture, { previous: host, sessionFile: await disposeOwner(host) });
	const recorded = await setModel(reopened, "set-preset-dormant", dormantPreset.agentId, preset);
	assert.deepEqual(recorded, {
		agentId: dormantPreset.agentId,
		disposition: "recorded",
		model: preset,
		thinkingLevel: "low",
	});
	for (const child of [livePreset, thenManual, dormantPreset]) {
		assert.ok(
			SessionManager.open(child.sessionFile).getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY),
			"the change is recorded as Virtual Model router state",
		);
	}

	// Preset routes at the serving entry's current level, which changes here.
	const final = await openOwner(t, fixture, { previous: host, sessionFile: await disposeOwner(reopened), policy: policy("high") });
	const cases = [
		{ name: "live preset change stays preset", child: livePreset, expected: "high" },
		{ name: "a later manual thinking change is explicit", child: thenManual, expected: "minimal" },
		{ name: "dormant preset change stays preset", child: dormantPreset, expected: "high" },
	];
	for (const { name, child, expected } of cases) {
		const request = await wake(fixture, final, child);
		assert.deepEqual(selectionOf(request), { model: key(INITIAL), reasoning: expected }, name);
		assert.equal(recordedSelection(child.sessionFile).model, "virtual/fast", name);
	}
	await final.runtime.dispose();
});

function workflowSessionDirectory(host: TestOwnerHost): string {
	return join(host.session.sessionManager.getSessionDir(), "pi-durable-subagents", host.session.sessionId);
}

async function waitForSessionFile(directory: string, agentId: string): Promise<string> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		for (const filename of await readdir(directory).catch(() => [] as string[])) {
			if (!filename.endsWith(".jsonl")) continue;
			const path = join(directory, filename);
			if (SessionManager.open(path).getSessionId() === agentId) return path;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Expected persisted session ${agentId}`);
}

type SessionEntry = ReturnType<SessionManager["getEntries"]>[number];

async function waitForAssistantText(sessionFile: string, text: string): Promise<void> {
	await waitForEntry(sessionFile, (entry) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "text" && part.text === text));
}

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: SessionEntry, index: number, entries: SessionEntry[]) => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (SessionManager.open(sessionFile).getEntries().some(predicate)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Expected transcript evidence did not commit in ${sessionFile}`);
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(message);
}
