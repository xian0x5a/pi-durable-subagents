import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createViewBackedParticipantHandlers } from "../src/coordination/view-backed-participant-handlers.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { registerParticipantLifecycle } from "../src/pi-integration/participant-lifecycle.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE, adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost, type TestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";

const SIDE_EFFECT_TOOL = "record_side_effect";

// Issue #237: signal shutdown disposes the Workflow before Pi stops its TUI, so a
// streaming Owner Run keeps firing hooks after the shutdown fence closes.
// Issue #238: that Run must also stop doing work once shutdown begins, even while
// the final native disposal is still pending.
test("a streaming Owner Run stops working and finishes quietly after Workflow shutdown begins while coordination stays fenced", { timeout: 15_000 }, async t => {
	const releaseNativeDisposal = deferred();
	// A failed assertion must not leave shutdown parked on held disposal during host cleanup,
	// so this hook is registered before the host's own disposal hook.
	t.after(() => releaseNativeDisposal.resolve());
	let view!: OrdinaryAgentCoordinatorView;
	const firedAfterShutdown = new Set<string>();
	const sideEffectsAfterShutdown: string[] = [];
	let shutdownBegun = false;
	const host = await createUnboundTestOwnerHost(t, pi => {
		registerParticipantLifecycle(pi, createViewBackedParticipantHandlers("owner", () => view).lifecycle);
		const record = (event: string) => () => { if (shutdownBegun) firedAfterShutdown.add(event); };
		pi.on("message_end", record("message_end"));
		pi.on("agent_end", record("agent_end"));
		pi.registerTool({
			name: SIDE_EFFECT_TOOL, label: "Side effect",
			description: "Performs an externally visible side effect.",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				if (shutdownBegun) sideEffectsAfterShutdown.push(toolCallId);
				return { content: [{ type: "text", text: "Side effect performed." }], details: {} };
			},
		});
	}, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	view = coordinator.forAgent(identity.agentId);

	const streaming = deferred();
	const releaseStream = deferred();
	let providerRequestsAfterShutdown = 0;
	host.model.setResponses([
		async () => {
			streaming.resolve();
			await releaseStream.promise;
			return fauxAssistantMessage(
				fauxToolCall(SIDE_EFFECT_TOOL, {}, { id: "side-effect-during-shutdown" }),
				{ stopReason: "toolUse" },
			);
		},
		() => {
			if (shutdownBegun) providerRequestsAfterShutdown += 1;
			return fauxAssistantMessage("Finished while the Workflow shuts down.");
		},
	]);
	const ownerRun = host.session.prompt("Keep streaming through shutdown.");
	await streaming.promise;

	// Hold native disposal so the Owner Run stays alive behind the closed fence,
	// as it does until Pi's final Owner lane discard.
	const shutdown = coordinator.shutdown(async () => {
		await releaseNativeDisposal.promise;
		await host.runtime.dispose();
	});
	shutdownBegun = true;
	releaseStream.resolve();
	await ownerRun;

	assert.deepEqual(sideEffectsAfterShutdown, [], "no native tool executes after shutdown began");
	assert.equal(providerRequestsAfterShutdown, 0, "no provider request is issued after shutdown began");
	// The stopped Run still finishes through its hooks, which must stay quiet (#237).
	for (const event of ["message_end", "agent_end"]) {
		assert.ok(firedAfterShutdown.has(event), `${event} finishes the stopped Run after shutdown began`);
	}
	assert.deepEqual(
		host.ui.notifications.filter(notification => notification.type === "error"),
		[],
		"no shutdown-time extension error is painted",
	);
	assert.notEqual(view.humanInputMode(), "run_suspended", "stopping for shutdown is not an Owner Run failure");

	const owner = createViewBackedParticipantHandlers("owner", () => view);
	await assert.rejects(async () => owner.coordination.observe({ operation: "status" }), /host_shutting_down/);
	await assert.rejects(
		async () => owner.coordination.message("message-after-shutdown", { operation: "poll", messageId: "message-1" }),
		/host_shutting_down/,
	);
	assert.equal(await owner.lifecycle.executionStarted(), "shutting_down", "execution start reports shutdown so the native Run aborts");

	releaseNativeDisposal.resolve();
	await shutdown;
});

// A signal shutdown keeps Pi's TUI up while the final native disposal is awaited, so
// the idle Owner can still receive input. None of it may start a new Owner Run.
test("no input starts an Owner Run after Workflow shutdown begins while native disposal is pending", { timeout: 20_000 }, async t => {
	const scenarios: ReadonlyArray<{
		name: string;
		submit(pi: ExtensionAPI, session: TestOwnerHost["session"]): Promise<void>;
	}> = [
		{
			name: "interactive prompt",
			submit: (_pi, session) => session.prompt("Typed by the human.", { source: "interactive" }),
		},
		{
			name: "extension user message",
			submit: (pi, session) => awaitingSessionCall(session, "sendUserMessage", () =>
				pi.sendUserMessage("Sent by another extension.")),
		},
		{
			name: "extension custom message with triggerTurn",
			submit: (pi, session) => awaitingSessionCall(session, "sendCustomMessage", () =>
				pi.sendMessage({ customType: "other-extension-note", content: "Wake up.", display: true }, { triggerTurn: true })),
		},
	];
	for (const scenario of scenarios) {
		await t.test(scenario.name, async t => {
			const releaseNativeDisposal = deferred();
			// Registered before the host's disposal hook so a failure cannot park cleanup.
			t.after(() => releaseNativeDisposal.resolve());
			let view!: OrdinaryAgentCoordinatorView;
			let otherExtension!: ExtensionAPI;
			const host = await createUnboundTestOwnerHost(t, pi => {
				registerParticipantLifecycle(pi, createViewBackedParticipantHandlers("owner", () => view).lifecycle);
			}, {
				persistent: true,
				additionalExtensionFactories: [pi => { otherExtension = pi; }],
			});
			await bindTestOwnerHost(host, "tui");
			const identity = adoptOrValidateOwnerIdentity(host.runtime);
			const coordinator = await createTestWorkflowCoordinator(host, identity, {
				entryModulePath: "<inline:pi-durable-subagents>",
			});
			view = coordinator.forAgent(identity.agentId);

			let providerRequests = 0;
			// The faux provider resolves a step before checking abort; real providers
			// throw on an aborted signal before any network call. Count live requests only.
			host.model.setResponses(Array.from({ length: 4 }, () => (_context, options) => {
				if (!options?.signal?.aborted) providerRequests += 1;
				return fauxAssistantMessage("Owner replied.");
			}));
			// Control: the same input starts an Owner Run before shutdown, so a zero
			// below means the input was refused, not that the harness never drove it.
			await scenario.submit(otherExtension, host.session);
			assert.equal(providerRequests, 1, "the input starts an Owner Run before shutdown");
			assert.equal(host.session.isIdle, true, "the Owner is idle when shutdown begins");
			const notificationsBeforeShutdown = host.ui.notifications.length;

			const shutdown = coordinator.shutdown(async () => {
				await releaseNativeDisposal.promise;
				await host.runtime.dispose();
			});
			const submission = await scenario.submit(otherExtension, host.session)
				.then(() => "resolved", (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`);
			await host.session.waitForIdle();

			t.diagnostic(`submission after shutdown: ${submission}`);
			t.diagnostic(`notifications after shutdown: ${JSON.stringify(host.ui.notifications.slice(notificationsBeforeShutdown))}`);
			assert.equal(providerRequests, 1, "no provider request is issued after shutdown began");

			releaseNativeDisposal.resolve();
			await shutdown;
		});
	}
});

/**
 * Pi's extension send APIs are fire-and-forget wrappers over the session methods.
 * Capture the session call they make so the test can await the input's full outcome.
 */
async function awaitingSessionCall(
	session: TestOwnerHost["session"],
	method: "sendUserMessage" | "sendCustomMessage",
	send: () => void,
): Promise<void> {
	type SessionSend = (...args: unknown[]) => Promise<void>;
	const methods = session as unknown as Record<typeof method, SessionSend>;
	const original = methods[method];
	let call: Promise<void> | undefined;
	methods[method] = (...args) => (call = original.apply(session, args));
	try {
		send();
	} finally {
		methods[method] = original;
	}
	assert.ok(call, `the extension API reached AgentSession.${method}`);
	await call;
}

// The checks below drive the handlers with a scripted participant view, because a
// real coordinator cannot be paused between a hook's transcript refresh and its
// remaining work, which is exactly where these shutdown races begin.
test("a root tool start ends quietly when shutdown begins during its refresh, but Run Suspension still refuses it", async t => {
	for (const scenario of [
		{ name: "shutdown begins during the refresh", beginsShutdown: true, suspended: false, expectedFailure: undefined },
		{ name: "the Run is suspended", beginsShutdown: false, suspended: true, expectedFailure: /run_suspended/ },
	]) {
		await t.test(scenario.name, async () => {
			const fence = scriptedFence();
			const admittedTools: string[] = [];
			const view = {
				...fence.view,
				async refreshTranscriptFacts() {
					fence.assertAdmissionOpen();
					if (scenario.beginsShutdown) fence.beginShutdown();
				},
				reconcileCommittedToolResults() {},
				assertNotShutDownOrSuspended() {
					fence.assertAdmissionOpen();
					if (scenario.suspended) throw new Error("run_suspended: explicit resume is required");
				},
				beginToolExecution(toolCallId: string) {
					fence.assertAdmissionOpen();
					admittedTools.push(toolCallId);
				},
			} as unknown as OrdinaryAgentCoordinatorView;
			const { lifecycle } = createViewBackedParticipantHandlers("owner", () => view);

			const started = lifecycle.rootToolExecutionStarted({ toolCallId: "tool-1", toolName: "read" });
			if (scenario.expectedFailure) await assert.rejects(started, scenario.expectedFailure);
			else assert.equal(await started, undefined);
			assert.deepEqual(admittedTools, []);
		});
	}
});

test("settlement after an Answer requests a continuation only while the Workflow is not shutting down", async t => {
	for (const scenario of [
		{ name: "no shutdown", shutdown: "never", continues: true },
		{ name: "shutdown already begun", shutdown: "before_settle", continues: false },
		{ name: "shutdown begins during the boundary refresh", shutdown: "during_settle_refresh", continues: false },
	] as const) {
		await t.test(scenario.name, async () => {
			const fence = scriptedFence();
			let beginShutdownOnRefresh = false;
			const view = {
				...fence.view,
				async refreshTranscriptFacts() {
					fence.assertAdmissionOpen();
					if (beginShutdownOnRefresh) fence.beginShutdown();
				},
				reconcileCommittedToolResults() {},
				async reachSafeBoundary() {},
			} as unknown as OrdinaryAgentCoordinatorView;
			const pi = new CapturedExtensionApi();
			registerParticipantLifecycle(pi.api, createViewBackedParticipantHandlers("owner", () => view).lifecycle);
			const context = participantContext();
			appendOpenRequest(context.sessionManager, "Remaining work");

			await pi.emit("turn_end", { type: "turn_end", toolResults: [answerResult] }, context);
			// Real Pi order is agent_end before agent_before_settle.
			await pi.emit("agent_end", { type: "agent_end", messages: [] }, context);
			if (scenario.shutdown === "before_settle") fence.beginShutdown();
			if (scenario.shutdown === "during_settle_refresh") beginShutdownOnRefresh = true;
			const settled = await pi.emit("agent_before_settle", {
				type: "agent_before_settle",
				context: { canContinue: true },
			}, context) as { continue?: boolean; entries?: unknown[] } | undefined;

			if (scenario.continues) {
				assert.equal(settled?.continue, true);
				assert.match(JSON.stringify(settled?.entries), /Remaining work/);
			} else {
				assert.notEqual(settled?.continue, true, "no new model work after the shutdown fence closes");
			}
			assert.deepEqual(pi.messages, []);
		});
	}
});

/** The Workflow shutdown fence as the coordinator applies it to every participant view. */
function scriptedFence() {
	let shuttingDown = false;
	const assertAdmissionOpen = () => {
		if (shuttingDown) throw new Error("host_shutting_down: Workflow is shutting down");
	};
	return {
		assertAdmissionOpen,
		beginShutdown() { shuttingDown = true; },
		view: { isShuttingDown: () => shuttingDown },
	};
}

// A locally committed Answer whose Delivery was omitted still ends its model loop.
const answerResult = {
	role: "toolResult" as const,
	toolCallId: "answer-call",
	toolName: "agent_message",
	content: [{ type: "text" as const, text: "Answered." }],
	details: {
		messageId: "answer", requestMessageId: "finished-request",
		disposition: "committed", delivery: "omitted", reason: "request_source_unavailable",
	},
	isError: false,
	timestamp: 1,
};

function appendOpenRequest(manager: SessionManager, title: string): void {
	const source = { agentId: "requester", entryId: title, toolCallId: title };
	const delivery = createMessageDelivery([{ source, projection: {
		kind: "request", requestMessageId: deriveMessageIdentity(source),
		fromAgentId: "requester", title, question: "Keep going",
	} }]);
	manager.appendCustomMessageEntry(delivery.customType, delivery.content, delivery.display, delivery.details);
}

function participantContext() {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: sessionManager.getSessionId() });
	const ui = { notify() {}, getEditorText: () => "", setEditorText() {} };
	return { ui, sessionManager, hasPendingMessages: () => false } as unknown as ExtensionContext & {
		sessionManager: SessionManager;
	};
}

type CapturedHandler = (event: never, context: ExtensionContext) => unknown;

/** Captures registered Pi hooks so a test can emit one boundary at a time. */
class CapturedExtensionApi {
	readonly #handlers = new Map<string, CapturedHandler>();
	readonly messages: unknown[] = [];
	readonly api = {
		on: (eventName: string, handler: CapturedHandler) => { this.#handlers.set(eventName, handler); },
		sendMessage: (message: unknown) => { this.messages.push(message); },
	} as unknown as ExtensionAPI;

	emit(eventName: string, event: unknown, context: ExtensionContext): Promise<unknown> {
		const handler = this.#handlers.get(eventName);
		assert.ok(handler, eventName);
		return Promise.resolve(handler(event as never, context));
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}
