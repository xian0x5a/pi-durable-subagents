import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { createViewBackedParticipantHandlers } from "../src/coordination/view-backed-participant-handlers.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import { registerParticipantLifecycle } from "../src/pi-integration/participant-lifecycle.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
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

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}
