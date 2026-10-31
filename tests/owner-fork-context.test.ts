import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectInheritedBoundary } from "../src/pi-integration/owner-fork-context.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

test("Owners without inherited model history get no boundary", () => {
	for (const prefix of ["none", "settings", "identity-only"] as const) {
		const manager = forkedManager();
		if (prefix === "settings") manager.appendCustomEntry("extension.settings", { enabled: true });
		if (prefix === "identity-only") manager.appendCustomEntry("agent-coordination.identity", { agentId: "source-owner" });
		appendOwnerIdentity(manager);
		manager.appendMessage({ role: "user", content: "Current work only", timestamp: 1 });
		const transcript = transcriptFromSessionManager(manager).inspect();
		assert.deepEqual(projectInheritedBoundary(transcript.context.messages, transcript), transcript.context.messages);
	}
});

test("without a canonical current Owner Identity no history counts as inherited", () => {
	const manager = forkedManager();
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "copied-owner" });
	manager.appendMessage({ role: "user", content: "No current identity", timestamp: 1 });
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.deepEqual(projectInheritedBoundary(transcript.context.messages, transcript), transcript.context.messages);
});

test("native history from before any source Identity counts as inherited", () => {
	const manager = forkedManager();
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "pre-bootstrap-file" }, { id: "pre-bootstrap-call" })));
	manager.appendCustomEntry("agent-coordination.identity", { agentId: "later-source-owner" });
	appendOwnerIdentity(manager);
	const transcript = transcriptFromSessionManager(manager).inspect();
	const projected = projectInheritedBoundary(transcript.context.messages, transcript);
	assert.deepEqual(projected.slice(0, -1), transcript.context.messages);
	assert.match(JSON.stringify(projected.at(-1)), /Inherited history boundary:/);
});

test("an inherited system message alone is not inherited history", () => {
	const manager = forkedManager();
	const system = manager.appendMessage({ role: "system", content: "Inherited prompt", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "Inherited work", timestamp: 2 });
	appendOwnerIdentity(manager);
	manager.branch(system);
	manager.appendMessage({ role: "user", content: "Bare branch work", timestamp: 3 });
	const transcript = transcriptFromSessionManager(manager).inspect();
	assert.equal(transcript.context.messages[0]?.role, "system");
	assert.deepEqual(projectInheritedBoundary(transcript.context.messages, transcript), transcript.context.messages);
});

test("only a forked session with a canonical Owner Identity turns earlier model entries into inherited history", () => {
	const owner = (sessionId: string) => ({ workflowId: sessionId, directSpawnerAgentId: null });
	const cases: Array<[string, () => SessionManager, (sessionId: string) => Record<string, unknown>, boolean]> = [
		["forked Owner", forkedManager, owner, true],
		["child", forkedManager, sessionId => ({ workflowId: sessionId, directSpawnerAgentId: "parent-agent" }), false],
		["Moderator", forkedManager, sessionId => ({ workflowId: sessionId, directSpawnerAgentId: null, spawnSource: { kind: "moderator" } }), false],
		["foreign Workflow", forkedManager, () => ({ workflowId: "other-workflow", directSpawnerAgentId: null }), false],
		["history before the Identity but no parent session", () => SessionManager.inMemory(), owner, false],
	];
	for (const [name, createManager, identity, expectsBoundary] of cases) {
		const manager = createManager();
		manager.appendMessage({ role: "user", content: "Looks inherited", timestamp: 1 });
		manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId(), ...identity(manager.getSessionId()) });
		manager.appendMessage({ role: "user", content: "Own work", timestamp: 2 });
		const transcript = transcriptFromSessionManager(manager).inspect();
		const projected = projectInheritedBoundary(transcript.context.messages, transcript);
		assert.equal(/Inherited history boundary:/.test(JSON.stringify(projected)), expectsBoundary, name);
	}
});

/** Pi records a fork through its header's parent session, which is what makes history inherited. */
function forkedManager(): SessionManager {
	const manager = SessionManager.inMemory();
	manager.newSession({ parentSession: "/source.jsonl" });
	return manager;
}

function appendOwnerIdentity(manager: SessionManager): void {
	manager.appendCustomEntry("agent-coordination.identity", {
		agentId: manager.getSessionId(), workflowId: manager.getSessionId(), directSpawnerAgentId: null,
		metadata: { label: "Owner", description: "Workflow Owner" },
	});
}
