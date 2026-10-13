import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createViewBackedParticipantHandlers } from "../src/coordination/view-backed-participant-handlers.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { registerParticipantLifecycle } from "../src/pi-integration/participant-lifecycle.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE, adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";

// Issue #237: signal shutdown disposes the Workflow before Pi stops its TUI, so a
// streaming Owner Run keeps firing hooks after the shutdown fence closes.
test("a streaming Owner Run finishes quietly after Workflow shutdown begins while coordination stays fenced", { timeout: 15_000 }, async t => {
	let view!: OrdinaryAgentCoordinatorView;
	const firedAfterShutdown = new Set<string>();
	let shutdownBegun = false;
	const host = await createUnboundTestOwnerHost(t, pi => {
		registerParticipantLifecycle(pi, createViewBackedParticipantHandlers("owner", () => view).lifecycle);
		const record = (event: string) => () => { if (shutdownBegun) firedAfterShutdown.add(event); };
		pi.on("message_end", record("message_end"));
		pi.on("tool_execution_start", record("tool_execution_start"));
		pi.on("turn_end", record("turn_end"));
		pi.on("agent_before_settle", record("agent_before_settle"));
		pi.on("agent_end", record("agent_end"));
	}, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: "<inline:pi-durable-subagents>",
	});
	view = coordinator.forAgent(identity.agentId);

	const streaming = deferred();
	const releaseStream = deferred();
	host.model.setResponses([
		async () => {
			streaming.resolve();
			await releaseStream.promise;
			return fauxAssistantMessage(
				fauxToolCall("read", { path: "absent-during-shutdown.txt" }, { id: "read-during-shutdown" }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Finished while the Workflow shuts down."),
	]);
	const ownerRun = host.session.prompt("Keep streaming through shutdown.");
	await streaming.promise;

	// Hold native disposal so the Owner Run stays alive behind the closed fence,
	// as it does until Pi's final Owner lane discard.
	const releaseNativeDisposal = deferred();
	const shutdown = coordinator.shutdown(async () => {
		await releaseNativeDisposal.promise;
		await host.runtime.dispose();
	});
	shutdownBegun = true;
	releaseStream.resolve();
	await ownerRun;

	assert.deepEqual(
		[...firedAfterShutdown].sort(),
		["agent_before_settle", "agent_end", "message_end", "tool_execution_start", "turn_end"],
		"every hook that finishes the streaming Run fired after shutdown began",
	);
	assert.deepEqual(
		host.ui.notifications.filter(notification => notification.type === "error"),
		[],
		"no shutdown-time extension error is painted",
	);

	const owner = createViewBackedParticipantHandlers("owner", () => view);
	await assert.rejects(async () => owner.coordination.observe({ operation: "status" }), /host_shutting_down/);
	await assert.rejects(
		async () => owner.coordination.message("message-after-shutdown", { operation: "poll", messageId: "message-1" }),
		/host_shutting_down/,
	);
	await assert.rejects(async () => owner.lifecycle.executionStarted(), /host_shutting_down/);

	releaseNativeDisposal.resolve();
	await shutdown;
});

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
