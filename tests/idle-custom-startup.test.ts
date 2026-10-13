import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { NativeSessionDriver } from "../src/pi-integration/native-session-driver.ts";
import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { createChildControlLoopback, loopbackOwnerHandlers } from "./support/child-control-loopback.ts";
import { createTestOwnerHost, type TestOwnerHost } from "./support/pi-host.ts";
import {
	preparedPromptMarker,
	registerStartupProbe,
	STARTUP_TOOL,
	STARTUP_TOOL_RESULT,
	type StartupProbeEvent,
} from "./fixtures/idle-custom-startup-extension.ts";

// The idle custom startup contract (docs/agent-messaging.md, "Idle custom
// startup") holds in the Owner Runtime and in a process child alike. Each case
// runs against both; child-only reminder and cancellation cases live in
// child-idle-custom-startup.

type CustomMessage = ReturnType<typeof createMessageDelivery>;
type DeliverAs = "steer" | "followUp";
type Dispatch = Readonly<{ completion: Promise<void>; transcriptCommit: Promise<boolean>; cancel(): Promise<void> }>;

type Harness = Readonly<{
	host: TestOwnerHost;
	probe: StartupProbeEvent[];
	deliver(message: CustomMessage, deliverAs?: DeliverAs): Dispatch;
	submitPrompt(text: string): Promise<void>;
	cancelled: RegExp;
}>;
/** The Owner case also exposes its driver, for Deliveries the shared harness does not shape. */
type OwnerHarness = Harness & Readonly<{ driver: NativeSessionDriver }>;
type StartHarness<H> = (t: TestContext, extension?: (pi: ExtensionAPI) => void) => Promise<H>;

const RUNTIMES: Readonly<{ Owner: StartHarness<OwnerHarness>; child: StartHarness<Harness> }> = {
	async Owner(t, extension) {
		const probe: StartupProbeEvent[] = [];
		const host = await createTestOwnerHost(t, piAgentCoordination, {
			fauxTokensPerSecond: 100_000,
			additionalExtensionFactories: [pi => { registerStartupProbe(pi, event => probe.push(event)); extension?.(pi); }],
		});
		const driver = new NativeSessionDriver(host.session);
		t.after(() => driver.dispose());
		return {
			host, probe, driver,
			deliver(message, deliverAs) {
				const cancellation = new AbortController();
				const dispatch = driver.deliver(customDelivery(message, deliverAs), { proveCommit: true, signal: cancellation.signal });
				return {
					completion: dispatch.completion,
					transcriptCommit: dispatch.transcriptCommit!,
					cancel: async () => cancellation.abort(new Error("owner delivery cancelled")),
				};
			},
			submitPrompt: text => host.session.prompt(text),
			cancelled: /owner delivery cancelled/,
		};
	},
	async child(t, extension) {
		const probe: StartupProbeEvent[] = [];
		const loopback = await createChildControlLoopback(t, {
			owner: loopbackOwnerHandlers(),
			configure: pi => { registerStartupProbe(pi, event => probe.push(event)); extension?.(pi); },
			host: { implicitModeratorResponses: false, fauxTokensPerSecond: 100_000 },
		});
		// Mirrors the proxy's own Delivery numbering, which message.cancel names.
		let deliveries = 0;
		return {
			host: loopback.host, probe,
			deliver(message, deliverAs) {
				const deliveryId = `delivery-${++deliveries}`;
				const dispatch = loopback.proxy.deliver(customDelivery(message, deliverAs), { inspectCommit: () => true });
				return {
					completion: dispatch.completion,
					transcriptCommit: dispatch.transcriptCommit!,
					async cancel() {
						assert.deepEqual(await loopback.ownerChannel.request("message.cancel", { deliveryId }), { accepted: true });
					},
				};
			},
			submitPrompt: text => loopback.submitNativeInput(text),
			cancelled: /child_turn_admission_cancelled/,
		};
	},
};

for (const [runtime, start] of Object.entries(RUNTIMES)) {
	for (const kind of ["message", "request"] as const) {
		test(`${runtime} starts first and settled idle ${kind} Runs natively, keeping preparation through a tool continuation`, { timeout: 5_000 }, async t => {
			const harness = await start(t);
			const contexts: Context[] = [];
			harness.host.model.setResponses([1, 2].flatMap(turn => [
				(context: Context) => {
					contexts.push(context);
					return fauxAssistantMessage(fauxToolCall(STARTUP_TOOL, {}, { id: `startup-probe-${turn}` }), { stopReason: "toolUse" });
				},
				(context: Context) => { contexts.push(context); return fauxAssistantMessage(`Startup ${turn} complete.`); },
			]));
			const messages = [customMessage(kind, `${runtime}-first`), customMessage(kind, `${runtime}-settled`)];
			for (const message of messages) {
				const dispatch = harness.deliver(message);
				assert.equal(await dispatch.transcriptCommit, true);
				await dispatch.completion;
				await harness.host.session.waitForIdle();
			}

			assert.deepEqual(harness.probe.filter(event => event.phase === "prepare"), [1, 2].map(preparation => ({
				phase: "prepare", messageType: "custom", customType: messages[0]!.customType, preparation,
			})), "before_agent_start runs once per Run, for the custom starting message");
			assert.deepEqual(harness.probe.filter(event => event.phase === "input"), [], "custom deliveries skip input handlers");
			assert.equal(harness.probe.filter(event => event.phase === "tool").length, 2);
			assert.equal(contexts.length, 4);
			for (const [call, context] of contexts.entries()) {
				assert.ok(getCurrentSystemPrompt(context.messages).includes(preparedPromptMarker(Math.floor(call / 2) + 1)),
					`provider call ${call + 1} keeps its Run's prepared system prompt`);
			}
			const toolResult = contexts[1]!.messages.findLast(message => message.role === "toolResult");
			assert.ok(toolResult?.role === "toolResult" && !toolResult.isError);
			assert.match(JSON.stringify(toolResult.content), new RegExp(STARTUP_TOOL_RESULT));
			assertCanonicalDeliveries(harness.host, messages);
		});
	}

	const inputWindowRows = [
		{ prompt: "started", deliverAs: "followUp", queued: ["followUp"], preparations: ["user"] },
		// A steer queued while the prompt's Run starts may join its very first request.
		{ prompt: "started", deliverAs: "steer", queued: ["steer"], preparations: ["user"] },
		{ prompt: "handled", deliverAs: "followUp", queued: [], preparations: ["custom"] },
	] as const;
	for (const row of inputWindowRows) {
		test(`${runtime} idle ${row.deliverAs} custom start waits out a prompt's async input and keeps its mode when the prompt is ${row.prompt}`, { timeout: 5_000 }, async t => {
			const holds = new InputHolds(t);
			const harness = await start(t, pi => holds.register(pi));
			const queued = spyQueuedCustomModes(harness.host);
			const contexts: string[] = [];
			harness.host.model.setResponses([
				async context => {
					contexts.push(JSON.stringify(context.messages));
					// Keep the prompt's Run active until the waiting Delivery could join it.
					if (row.prompt === "started") await Promise.race([queued.seen, delay(1_000)]);
					return fauxAssistantMessage("First Run response.");
				},
				context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Second response."); },
			]);
			const hold = holds.hold("Human work in its input phase.");
			const prompt = harness.submitPrompt("Human work in its input phase.");
			await hold.entered;
			const message = customMessage("message", `${runtime}-${row.prompt}-${row.deliverAs}`);
			const dispatch = harness.deliver(message, row.deliverAs);
			await delay(50);
			assert.equal(harness.host.session.isIdle, true, "the waiting Delivery starts no Run while the prompt is in input");
			assert.equal(committedCustomEntries(harness.host, message).length, 0);
			hold.release(row.prompt === "handled" ? { action: "handled" } : undefined);

			await prompt;
			assert.equal(await dispatch.transcriptCommit, true);
			await dispatch.completion;
			await harness.host.session.waitForIdle();
			assert.deepEqual(queued.modes, row.queued);
			assert.deepEqual(harness.probe.flatMap(event => event.phase === "prepare" ? [event.messageType] : []), row.preparations);
			if (row.deliverAs === "followUp") {
				assert.equal(contexts.length, row.prompt === "handled" ? 1 : 2);
				if (row.prompt === "started") assert.equal(contexts[0]!.includes(bodyOf(message)), false, "a follow-up waits for the prompt's own turn");
			}
			assert.ok(contexts.at(-1)!.includes(bodyOf(message)));
			assert.equal(userMessages(harness.host).length, row.prompt === "handled" ? 0 : 1);
			assert.equal(committedCustomEntries(harness.host, message).length, 1);
			assert.equal(harness.host.session.pendingMessageCount, 0);
		});
	}

	test(`${runtime} cancels a custom start waiting on a prompt's input without touching that prompt; explicit retry commits once`, { timeout: 5_000 }, async t => {
		const holds = new InputHolds(t);
		const harness = await start(t, pi => holds.register(pi));
		const contexts: string[] = [];
		harness.host.model.setResponses([
			context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Prompt done."); },
			context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Retry done."); },
		]);
		const hold = holds.hold("Human work.");
		const prompt = harness.submitPrompt("Human work.");
		await hold.entered;
		const message = customMessage("message", `${runtime}-cancelled-while-waiting`);
		const dispatch = harness.deliver(message, "followUp");
		await delay(20);
		await dispatch.cancel();
		// The waiting Delivery must fail while the prompt is still in its input phase.
		await within(Promise.all([
			assert.rejects(dispatch.completion, harness.cancelled),
			assert.rejects(dispatch.transcriptCommit, harness.cancelled),
		]), "cancelled Delivery kept waiting for the prompt");
		hold.release(undefined);
		await prompt;
		await harness.host.session.waitForIdle();
		assert.equal(contexts.length, 1);
		assert.equal(contexts[0]!.includes(bodyOf(message)), false);
		assert.equal(committedCustomEntries(harness.host, message).length, 0);

		const retry = harness.deliver(message, "followUp");
		assert.equal(await retry.transcriptCommit, true);
		await retry.completion;
		await harness.host.session.waitForIdle();
		assert.equal(committedCustomEntries(harness.host, message).length, 1);
		assert.deepEqual(harness.probe.flatMap(event => event.phase === "prepare" ? [event.messageType] : []), ["user", "custom"]);
	});

	test(`${runtime} custom Delivery sent during a custom Run's before_agent_start joins that Run`, { timeout: 5_000 }, async t => {
		let nested: Dispatch | undefined;
		let harness!: Harness;
		const nestedMessage = customMessage("message", `${runtime}-nested`);
		harness = await start(t, pi => pi.on("before_agent_start", () => {
			// Not awaited: a queued Delivery completes with the Run it joins.
			nested ??= harness.deliver(nestedMessage, "followUp");
		}));
		const contexts: string[] = [];
		harness.host.model.setResponses([
			context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Outer handled."); },
			context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Nested handled."); },
		]);
		const outerMessage = customMessage("message", `${runtime}-outer`);
		const outer = harness.deliver(outerMessage);
		assert.equal(await outer.transcriptCommit, true);
		assert.ok(nested);
		assert.equal(await nested.transcriptCommit, true);
		await Promise.all([outer.completion, nested.completion]);
		await harness.host.session.waitForIdle();
		assert.equal(harness.probe.filter(event => event.phase === "prepare").length, 1, "the nested Delivery starts no Run of its own");
		assert.ok(contexts.some(context => context.includes(bodyOf(nestedMessage))));
		assertCanonicalDeliveries(harness.host, [outerMessage, nestedMessage]);
	});
}

test("Owner custom start keeps waiting until every overlapping prompt leaves its input phase", { timeout: 5_000 }, async t => {
	const holds = new InputHolds(t);
	const harness = await RUNTIMES.Owner(t, pi => holds.register(pi));
	const queued = spyQueuedCustomModes(harness.host);
	harness.host.model.setResponses([
		async () => { await Promise.race([queued.seen, delay(1_000)]); return fauxAssistantMessage("Second prompt done."); },
		fauxAssistantMessage("Follow-up done."),
	]);
	const first = holds.hold("First prompt.");
	const second = holds.hold("Second prompt.");
	const firstPrompt = harness.submitPrompt("First prompt.");
	const secondPrompt = harness.host.session.prompt("Second prompt.", { source: "extension" });
	await Promise.all([first.entered, second.entered]);
	const message = customMessage("message", "overlapping-prompts");
	const dispatch = harness.deliver(message, "followUp");
	first.release({ action: "handled" });
	await firstPrompt;
	await delay(50);
	assert.equal(harness.host.session.isIdle, true, "one prompt still in input keeps the custom start waiting");
	assert.equal(committedCustomEntries(harness.host, message).length, 0);
	second.release(undefined);
	await secondPrompt;
	assert.equal(await dispatch.transcriptCommit, true);
	await dispatch.completion;
	await harness.host.session.waitForIdle();
	assert.deepEqual(queued.modes, ["followUp"]);
	assert.equal(committedCustomEntries(harness.host, message).length, 1);
});

test("Owner Runtime custom Delivery sent on its agent_settled event proves the Run it starts", { timeout: 5_000 }, async t => {
	// The Run supervisor reacts to this event; Pi defers a Run requested while it
	// emits settlement until every settled listener returns.
	const harness = await RUNTIMES.Owner(t);
	const runtime = InProcessHostedRuntime.fromSession({ session: harness.host.session, services: harness.host.services, projection: undefined });
	const followUp = customMessage("message", "from-settlement");
	let settledDelivery: ReturnType<InProcessHostedRuntime["deliver"]> | undefined;
	const unsubscribe = runtime.subscribe(event => {
		if (event.type === "agent_settled") settledDelivery ??= runtime.deliver(customDelivery(followUp, undefined), { inspectCommit: () => true });
	});
	t.after(unsubscribe);
	harness.host.model.setResponses([fauxAssistantMessage("First done."), fauxAssistantMessage("Settled follow-up done.")]);
	const first = customMessage("message", "before-settlement");
	const dispatch = harness.deliver(first);
	assert.equal(await dispatch.transcriptCommit, true);
	await dispatch.completion;
	assert.ok(settledDelivery);
	const committed = await settledDelivery.transcriptCommit;
	await settledDelivery.completion;
	await harness.host.session.waitForIdle();
	assert.deepEqual(harness.probe.flatMap(event => event.phase === "prepare" ? [event.messageType] : []), ["custom", "custom"]);
	assertCanonicalDeliveries(harness.host, [first, followUp]);
	assert.equal(committed, true, "the deferred Run committed the Delivery, so its proof must confirm it");
});

for (const row of [
	{ name: "Owner follow-up sent while a custom start prepares is not stranded when that start is cancelled", delayRejectedStart: false },
	// Joiner release must follow the failed start's own settlement, not a fixed
	// number of microtasks after agent.prompt rejects.
	{ name: "Owner follow-up behind a cancelled custom start is not stranded when agent.prompt's rejection reaches Pi late", delayRejectedStart: true },
]) test(row.name, { timeout: 5_000 }, async t => {
	const cancelledMessage = customMessage("message", "cancelled-start");
	const joinerMessage = customMessage("message", "joiner-behind-cancelled");
	const startingContents: string[] = [];
	let preparationEntered!: () => void;
	const entered = new Promise<void>(resolve => { preparationEntered = resolve; });
	let releasePreparation!: () => void;
	const released = new Promise<void>(resolve => { releasePreparation = resolve; });
	t.after(() => releasePreparation());
	const harness = await RUNTIMES.Owner(t, pi => pi.on("before_agent_start", async event => {
		if (event.messageType !== "custom") return;
		startingContents.push(JSON.stringify(event.message.content));
		if (startingContents.length > 1) return;
		preparationEntered();
		await released;
	}));
	if (row.delayRejectedStart) delayRejectedAgentPrompt(harness.host);
	const contexts: string[] = [];
	harness.host.model.setResponses([
		context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Joiner handled."); },
	]);
	const cancelled = harness.deliver(cancelledMessage);
	await within(entered, "the first custom start never reached before_agent_start");
	const joiner = harness.deliver(joinerMessage, "followUp");
	await delay(20);
	await cancelled.cancel();
	releasePreparation();

	await within(assert.rejects(cancelled.completion, harness.cancelled), "the cancelled start's dispatch did not fail");
	assert.equal(await within(cancelled.transcriptCommit.catch(() => false), "the cancelled proof never settled"), false);
	assert.equal(await within(joiner.transcriptCommit, "the follow-up was stranded behind the cancelled start"), true);
	await within(joiner.completion, "the follow-up's dispatch never completed");
	await within(harness.host.session.waitForIdle(), "the session never returned to idle");

	assert.equal(committedCustomEntries(harness.host, cancelledMessage).length, 0, "the cancelled start commits nothing");
	assert.equal(committedCustomEntries(harness.host, joinerMessage).length, 1);
	assert.deepEqual(startingContents, [cancelledMessage, joinerMessage].map(message => JSON.stringify(message.content)),
		"the follow-up starts its own Run after the cancelled one");
	assert.equal(contexts.length, 1);
	assert.ok(contexts[0]!.includes(bodyOf(joinerMessage)));
	assert.equal(contexts[0]!.includes(bodyOf(cancelledMessage)), false);
	assert.equal(harness.host.session.isIdle, true);
	assert.equal(harness.host.session.agent.hasQueuedMessages(), false, "nothing is left in agent-core's queue");
	assert.equal(harness.host.session.pendingMessageCount, 0);
});

test("Owner custom start whose driver is disposed while it prepares rejects its proof and commits nothing", { timeout: 5_000 }, async t => {
	const preparation = holdFirstPreparation(t, "custom");
	const harness = await RUNTIMES.Owner(t, pi => preparation.register(pi));
	const contexts: string[] = [];
	harness.host.model.setResponses([
		context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Disposed start ran."); },
	]);
	const message = customMessage("message", "disposed-while-preparing");
	const dispatch = harness.deliver(message);
	await within(preparation.entered, "the custom start never reached before_agent_start");
	harness.driver.dispose();
	preparation.release();

	await within(assert.rejects(dispatch.transcriptCommit, /native_session_driver_disposed/), "the disposed driver's proof did not reject");
	await within(dispatch.completion.catch(() => undefined), "the disposed start's dispatch never settled");
	await within(harness.host.session.waitForIdle(), "the session never returned to idle");
	// A rejected proof makes the caller retry, so the entry must not exist.
	assert.equal(committedCustomEntries(harness.host, message).length, 0, "a rejected proof must mean uncommitted");
	assert.deepEqual(contexts, [], "the disposed start reached the model");
	assert.equal(harness.host.session.isIdle, true);
});

test("Owner user start cancelled while it prepares commits nothing and does not strand a custom follow-up that joined it", { timeout: 5_000 }, async t => {
	const preparation = holdFirstPreparation(t, "user");
	const harness = await RUNTIMES.Owner(t, pi => preparation.register(pi));
	const contexts: string[] = [];
	harness.host.model.setResponses([
		context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Joiner handled."); },
	]);
	const userText = "Cancelled user start text.";
	const cancellation = new AbortController();
	const user = harness.driver.deliver({ kind: "user", content: userText }, { proveCommit: true, signal: cancellation.signal });
	await within(preparation.entered, "the user start never reached before_agent_start");
	const joinerMessage = customMessage("message", "joiner-behind-cancelled-user");
	const joiner = harness.deliver(joinerMessage, "followUp");
	await delay(20);
	cancellation.abort(new Error("user delivery cancelled"));
	preparation.release();

	await within(assert.rejects(user.completion, /user delivery cancelled/), "the cancelled user start's dispatch did not fail");
	assert.equal(await within(user.transcriptCommit!.catch(() => false), "the cancelled user proof never settled"), false);
	assert.equal(await within(joiner.transcriptCommit, "the follow-up was stranded behind the cancelled user start"), true);
	await within(joiner.completion, "the follow-up's dispatch never completed");
	await within(harness.host.session.waitForIdle(), "the session never returned to idle");

	assert.equal(JSON.stringify(harness.host.session.sessionManager.getEntries()).includes(userText), false,
		"the cancelled user text reached the transcript");
	assert.equal(committedCustomEntries(harness.host, joinerMessage).length, 1);
	assert.equal(contexts.length, 1);
	assert.ok(contexts[0]!.includes(bodyOf(joinerMessage)));
	assert.equal(contexts[0]!.includes(userText), false);
	assert.equal(harness.host.session.isIdle, true);
	assert.equal(harness.host.session.agent.hasQueuedMessages(), false, "nothing is left in agent-core's queue");
});

test("Owner commit proof settling on agent_settled leaves later listeners that event", { timeout: 5_000 }, async t => {
	// A start cancelled during preparation never commits, so its proof settles
	// inside Pi's agent_settled emit rather than at a message_end.
	let preparationEntered!: () => void;
	const entered = new Promise<void>(resolve => { preparationEntered = resolve; });
	let releasePreparation!: () => void;
	const released = new Promise<void>(resolve => { releasePreparation = resolve; });
	t.after(() => releasePreparation());
	const harness = await RUNTIMES.Owner(t, pi => pi.on("before_agent_start", async event => {
		if (event.messageType !== "custom") return;
		preparationEntered();
		await released;
	}));
	const message = customMessage("message", "proof-settles-in-emit");
	const dispatch = harness.deliver(message);
	await within(entered, "the custom start never reached before_agent_start");
	// Subscribed after the proof began watching the session.
	let laterListenerSettled = 0;
	t.after(harness.host.session.subscribe(event => {
		if (event.type === "agent_settled") laterListenerSettled++;
	}));
	await dispatch.cancel();
	releasePreparation();

	assert.equal(await within(dispatch.transcriptCommit.catch(() => false), "the cancelled proof never settled"), false);
	await within(assert.rejects(dispatch.completion, harness.cancelled), "the cancelled start's dispatch did not fail");
	await within(harness.host.session.waitForIdle(), "the session never returned to idle");
	assert.equal(laterListenerSettled, 1, "the proof's own unsubscribe must not hide agent_settled from the next listener");
	assert.equal(committedCustomEntries(harness.host, message).length, 0);
});

test("Owner extension command held open does not hold an idle custom start", { timeout: 5_000 }, async t => {
	let commandEntered!: () => void;
	const entered = new Promise<void>(resolve => { commandEntered = resolve; });
	let releaseCommand!: () => void;
	const commandReleased = new Promise<void>(resolve => { releaseCommand = resolve; });
	t.after(() => releaseCommand());
	const harness = await RUNTIMES.Owner(t, pi => pi.registerCommand("hold-open", {
		description: "Stays open until the test releases it.",
		handler: async () => { commandEntered(); await commandReleased; },
	}));
	const driver = new NativeSessionDriver(harness.host.session);
	t.after(() => driver.dispose());
	harness.host.model.setResponses([fauxAssistantMessage("Started beside the open command.")]);
	let commandReturned = false;
	const command = harness.submitPrompt("/hold-open").then(() => { commandReturned = true; });
	await within(entered, "the extension command never ran");
	assert.equal(harness.host.session.isIdle, true);
	assert.equal(driver.canStartIdleTurn(), true, "an open extension command starts no Run");

	const message = customMessage("message", "beside-open-command");
	const dispatch = harness.deliver(message);
	assert.equal(await within(dispatch.transcriptCommit, "the idle custom start waited on the open command"), true);
	await within(dispatch.completion, "the idle custom Run never completed");
	assert.equal(commandReturned, false, "the Delivery committed while the command was still open");
	releaseCommand();
	await within(command, "the extension command never returned");
	await within(harness.host.session.waitForIdle(), "the session never returned to idle");
	assert.deepEqual(harness.probe.flatMap(event => event.phase === "prepare" ? [event.messageType] : []), ["custom"]);
	assertCanonicalDeliveries(harness.host, [message]);
});

function customDelivery(message: CustomMessage, deliverAs: DeliverAs | undefined) {
	return { kind: "custom" as const, message, triggerTurn: true, ...(deliverAs === undefined ? {} : { deliverAs }) };
}

const bodies = new WeakMap<CustomMessage, string>();

/** The Delivery's body text, which a provider context carries verbatim. */
function bodyOf(message: CustomMessage): string {
	return bodies.get(message)!;
}

function customMessage(kind: "message" | "request", id: string): CustomMessage {
	const source = { agentId: "startup-author", entryId: `startup-entry-${id}`, toolCallId: `startup-call-${id}` };
	const content = `Startup work ${id}.`;
	const message = createMessageDelivery([{ source, projection: kind === "message"
		? { kind, messageId: deriveMessageIdentity(source), fromAgentId: source.agentId, content }
		: { kind, requestMessageId: deriveMessageIdentity(source), fromAgentId: source.agentId, title: `Startup ${id}`, question: content },
	}]);
	bodies.set(message, content);
	return message;
}

function committedCustomEntries(host: TestOwnerHost, message: CustomMessage) {
	return host.session.sessionManager.getEntries().filter(entry =>
		entry.type === "custom_message" && entry.customType === message.customType &&
		JSON.stringify(entry.content) === JSON.stringify(message.content));
}

function userMessages(host: TestOwnerHost) {
	return host.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
}

/** Exactly one canonical entry per Delivery with every field intact, and no kickoff prompt. */
function assertCanonicalDeliveries(host: TestOwnerHost, messages: readonly CustomMessage[]): void {
	const entries = host.session.sessionManager.getEntries().flatMap(entry =>
		entry.type === "custom_message" && entry.customType === messages[0]!.customType ? [entry] : []);
	assert.deepEqual(entries.map(({ customType, content, display, details }) => ({ customType, content, display, details })), messages);
	assert.deepEqual(userMessages(host), [], "an idle custom start commits no user entry");
	assert.equal(host.session.pendingMessageCount, 0);
}

/** Records the queue mode of every custom message Pi hands to an active Run. */
function spyQueuedCustomModes(host: TestOwnerHost) {
	const modes: DeliverAs[] = [];
	let markSeen!: () => void;
	const seen = new Promise<void>(resolve => { markSeen = resolve; });
	const agent = host.session.agent;
	for (const mode of ["steer", "followUp"] as const) {
		const native = agent[mode].bind(agent);
		agent[mode] = message => {
			if (message.role === "custom") { modes.push(mode); markSeen(); }
			native(message);
		};
	}
	return { modes, seen };
}

type InputResult = { action: "handled" } | undefined;

/** Holds chosen prompts inside an async `input` handler until the test releases them. */
class InputHolds {
	readonly #holds = new Map<string, { entered: () => void; released: Promise<InputResult> }>();
	readonly #releases: Array<() => void> = [];

	constructor(t: TestContext) {
		t.after(() => { for (const release of this.#releases) release(); });
	}

	register(pi: ExtensionAPI): void {
		pi.on("input", async event => {
			const hold = this.#holds.get(event.text);
			if (!hold) return undefined;
			this.#holds.delete(event.text);
			hold.entered();
			return hold.released;
		});
	}

	hold(text: string) {
		let entered!: () => void;
		let release!: (result: InputResult) => void;
		const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
		const released = new Promise<InputResult>(resolve => { release = resolve; });
		this.#releases.push(() => release(undefined));
		this.#holds.set(text, { entered, released });
		return { entered: enteredPromise, release };
	}
}

/** Holds the first native Run start of one message type inside `before_agent_start`. */
function holdFirstPreparation(t: TestContext, messageType: "custom" | "user") {
	let markEntered!: () => void;
	const entered = new Promise<void>(resolve => { markEntered = resolve; });
	let release!: () => void;
	const released = new Promise<void>(resolve => { release = resolve; });
	t.after(() => release());
	let held = false;
	return {
		entered,
		release,
		register(pi: ExtensionAPI) {
			pi.on("before_agent_start", async event => {
				if (event.messageType !== messageType || held) return;
				held = true;
				markEntered();
				await released;
			});
		},
	};
}

/** Outermost `agent.prompt` wrapper that hands a rejection back to Pi only after several microtasks. */
function delayRejectedAgentPrompt(host: TestOwnerHost): void {
	const agent = host.session.agent;
	const inner = agent.prompt;
	agent.prompt = async function (this: typeof agent, ...args: unknown[]) {
		try {
			return await (Reflect.apply(inner, this, args) as Promise<void>);
		} catch (error) {
			for (let tick = 0; tick < 6; tick++) await Promise.resolve();
			throw error;
		}
	} as typeof agent.prompt;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function within<T>(operation: Promise<T>, failure: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(failure)), 1_000);
		})]);
	} finally { clearTimeout(timer); }
}

async function waitUntil(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Idle custom startup condition did not settle within 2s");
		await delay(5);
	}
}
