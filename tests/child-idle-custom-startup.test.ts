import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createChildControlLoopback, loopbackOwnerHandlers, type ChildControlLoopback } from "./support/child-control-loopback.ts";
import {
	preparedPromptMarker,
	registerStartupProbe,
	STARTUP_TOOL,
	type StartupProbeEvent,
} from "./fixtures/idle-custom-startup-extension.ts";

// Child-only idle custom startup: the Moderator's separate reminder path and
// cancellation before a Run reaches native start. Behavior shared with the
// Owner Runtime is covered once per runtime in idle-custom-startup.

test("a child starts the separate Moderator reminder natively on first and settled Runs through a tool continuation", { timeout: 5_000 }, async t => {
	const child = await startChild(t);
	const contexts: Context[] = [];
	child.loopback.host.model.setResponses([1, 2].flatMap(turn => [
		(context: Context) => {
			contexts.push(context);
			return fauxAssistantMessage(fauxToolCall(STARTUP_TOOL, {}, { id: `reminder-probe-${turn}` }), { stopReason: "toolUse" });
		},
		(context: Context) => { contexts.push(context); return fauxAssistantMessage(`Reminder ${turn} handled.`); },
	]));
	for (const turn of [1, 2]) {
		const settled = nextSettlement(child.loopback);
		assert.equal(await child.loopback.proxy.deliverModeratorReminder(commit => commit()), "committed");
		await settled;
		assert.equal(reminders(child.loopback).length, turn, "each admitted reminder commits exactly once");
	}
	assert.deepEqual(child.probe.filter(event => event.phase === "prepare"), [1, 2].map(preparation => ({
		phase: "prepare", messageType: "custom", customType: MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE, preparation,
	})));
	assert.deepEqual(child.probe.filter(event => event.phase === "input"), []);
	assert.equal(contexts.length, 4);
	for (const [call, context] of contexts.entries()) {
		assert.ok(getCurrentSystemPrompt(context.messages).includes(preparedPromptMarker(Math.floor(call / 2) + 1)),
			`provider call ${call + 1} keeps its Run's prepared system prompt`);
	}
	assert.equal(userEntries(child.loopback).length, 0, "the reminder commits no kickoff prompt");
	assert.equal(child.humanInputs(), 0);
});

test("a Moderator reminder is busy while another custom Run runs its before_agent_start", { timeout: 5_000 }, async t => {
	const preparing = deferred();
	const release = deferred();
	t.after(release.resolve);
	const child = await startChild(t, pi => pi.on("before_agent_start", async () => { preparing.resolve(); await release.promise; }));
	child.loopback.host.model.setResponses([fauxAssistantMessage("Message handled.")]);
	const message = customMessage("busy-reminder");
	const delivery = child.loopback.proxy.deliver({ kind: "custom", message, triggerTurn: true }, { inspectCommit: () => true });
	await preparing.promise;
	assert.equal(await child.loopback.proxy.deliverModeratorReminder(commit => commit()), "busy");
	release.resolve();
	assert.equal(await delivery.transcriptCommit, true);
	await delivery.completion;
	await child.loopback.host.session.waitForIdle();
	assert.equal(reminders(child.loopback).length, 0, "a busy reminder never joins the starting Run");
	assert.equal(child.probe.filter(event => event.phase === "prepare").length, 1);
});

const cancellationRows = [
	{ name: "its own message.cancel", cancel: (loopback: ChildControlLoopback) => loopback.ownerChannel.request("message.cancel", { deliveryId: "delivery-1" }) },
	{ name: "a runtime interrupt", cancel: (loopback: ChildControlLoopback) => loopback.proxy.abort() },
] as const;
for (const row of cancellationRows) {
	test(`a child Delivery cancelled by ${row.name} during before_agent_start commits nothing; explicit retry commits once`, { timeout: 5_000 }, async t => {
		const preparing = deferred();
		const release = deferred();
		t.after(release.resolve);
		let holdPreparation = true;
		const child = await startChild(t, pi => pi.on("before_agent_start", async () => {
			if (!holdPreparation) return;
			holdPreparation = false;
			preparing.resolve();
			await release.promise;
		}));
		let modelCalls = 0;
		child.loopback.host.model.setResponses([() => { modelCalls++; return fauxAssistantMessage("Retry handled."); }]);
		const message = customMessage(`cancel-${row.name}`);
		const cancelled = child.loopback.proxy.deliver({ kind: "custom", message, triggerTurn: true }, { inspectCommit: () => true });
		const rejected = assert.rejects(cancelled.completion, /child_turn_admission_cancelled/);
		await preparing.promise;
		await row.cancel(child.loopback);
		release.resolve();
		await rejected;
		assert.equal(await cancelled.transcriptCommit, false);
		await child.loopback.host.session.waitForIdle();
		assert.equal(modelCalls, 0, "the cancelled Run never reaches the model");
		assert.equal(customEntries(child.loopback, message).length, 0, "nothing commits before native start");

		const retry = child.loopback.proxy.deliver({ kind: "custom", message, triggerTurn: true }, { inspectCommit: () => true });
		assert.equal(await retry.transcriptCommit, true);
		await retry.completion;
		await child.loopback.host.session.waitForIdle();
		assert.equal(modelCalls, 1);
		assert.equal(customEntries(child.loopback, message).length, 1);
		assert.equal(child.loopback.events.filter(event => event.event === "runtime.fault").length, 0);
	});
}

async function startChild(t: TestContext, extension?: (pi: ExtensionAPI) => void) {
	const probe: StartupProbeEvent[] = [];
	let humanInputs = 0;
	const owner = loopbackOwnerHandlers();
	const loopback = await createChildControlLoopback(t, {
		owner: { ...owner, lifecycle: { ...owner.lifecycle, humanInputSubmitted: async () => { humanInputs++; return "continue"; } } },
		configure: pi => { registerStartupProbe(pi, event => probe.push(event)); extension?.(pi); },
		host: { implicitModeratorResponses: false, fauxTokensPerSecond: 100_000 },
	});
	return { loopback, probe, humanInputs: () => humanInputs };
}

function customMessage(id: string) {
	const source = { agentId: "startup-sender", entryId: `startup-entry-${id}`, toolCallId: `startup-call-${id}` };
	return createMessageDelivery([{ source, projection: {
		kind: "message", messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content: `Child startup ${id}.`,
	} }]);
}

function entries({ host }: ChildControlLoopback) {
	return host.session.sessionManager.getEntries();
}

function reminders(loopback: ChildControlLoopback) {
	return entries(loopback).filter(entry => entry.type === "custom_message" && entry.customType === MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE);
}

function customEntries(loopback: ChildControlLoopback, message: ReturnType<typeof customMessage>) {
	return entries(loopback).filter(entry => entry.type === "custom_message" &&
		entry.customType === message.customType && JSON.stringify(entry.content) === JSON.stringify(message.content));
}

function userEntries(loopback: ChildControlLoopback) {
	return entries(loopback).filter(entry => entry.type === "message" && entry.message.role === "user");
}

function nextSettlement({ proxy }: ChildControlLoopback): Promise<void> {
	return new Promise(resolve => {
		const remove = proxy.subscribe(event => {
			if (event.type !== "agent_settled") return;
			remove();
			resolve();
		});
	});
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => { resolve = yes; });
	return { promise, resolve };
}
