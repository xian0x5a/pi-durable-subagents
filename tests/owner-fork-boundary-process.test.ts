import "./support/supervised-run.ts";
import { findDeliveredRequest } from "./support/model-requests.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall, type Context, type FauxResponseFactory } from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
import { executeAndCommitRegisteredTool, executeRegisteredTool } from "./support/agent-session.ts";
import { createTestOwnerHost, type TestOwnerHost } from "./support/pi-host.ts";
import {
	BOUNDARY, INHERITED_SHAPE, boundaryCount, forkedOwner, messageEntryId, promptAndRecord, recording, shapeOf, textOf, waitFor,
} from "./support/owner-fork-boundary.ts";

test("a Delivery on a fork stays the newest model-visible message below the boundary", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t, { processVisibleModel: true });
	try {
		const deliveredTurns: Context[] = [];
		const route: FauxResponseFactory = context => {
			const text = JSON.stringify(context.messages);
			// Only the Owner's context carries the inherited history.
			if (text.includes("Source start.")) {
				if (text.includes("LATE_DELIVERY_MARKER")) {
					deliveredTurns.push(structuredClone(context));
					return fauxAssistantMessage("Delivery handled.");
				}
				return text.includes("spawn-delivery-child")
					? fauxAssistantMessage("Child spawned.")
					: fauxAssistantMessage(fauxToolCall("agent_spawn", {
						title: "Fixture request", request: "Answer the Owner with a late result.",
					}, { id: "spawn-delivery-child" }), { stopReason: "toolUse" });
			}
			return text.includes("answer-delivery-child")
				? fauxAssistantMessage("Child done.")
				: fauxAssistantMessage(fauxToolCall("agent_message", {
					operation: "answer", requestId: findDeliveredRequest(context)!.requestMessageId, answer: "LATE_DELIVERY_MARKER",
				}, { id: "answer-delivery-child" }), { stopReason: "toolUse" });
		};
		host.model.setResponses(Array.from({ length: 12 }, () => route));
		await fork.prompt("Start the delivery child.");
		await waitFor(() => deliveredTurns.length > 0, "the Owner's Delivery turn");
		await fork.waitForIdle();
		assert.ok(deliveredTurns.length > 0, "the Owner saw the Delivery");
		const messages = deliveredTurns[0]!.messages;
		assert.match(textOf(messages.at(-1)!), /LATE_DELIVERY_MARKER/);
		const shape = shapeOf(messages);
		assert.equal(shape.filter(line => line === BOUNDARY).length, 1);
		assert.deepEqual(shape.slice(0, INHERITED_SHAPE.length + 1), [...INHERITED_SHAPE, BOUNDARY]);
		assert.ok(shape.indexOf(BOUNDARY) < shape.length - 1, "the boundary sits above the Delivery");
	} finally {
		await host.runtime.dispose();
	}
});

test("a child session never gets a boundary", { timeout: 10_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	try {
		const childRequests: Context[] = [];
		host.model.setResponses([recording(childRequests, "Child ready.")]);
		await executeAndCommitRegisteredTool(host.runtime.session, "agent_spawn", "spawn-boundary-child", {
			title: "Fixture request", request: "Stay ready for boundary inspection.",
		});
		await waitFor(() => childRequests.length > 0, "the child's first model request");
		assert.equal(childRequests.every(request => boundaryCount(request.messages) === 0), true);
	} finally {
		await host.runtime.dispose();
	}
});

type ScopeFacts = { childId: string; creationRequestId: string; incomingRequestId: string };

const OWNER_CONTEXT_MARKER = "START_SCOPE_SOURCE";

/**
 * Drives an Owner session through spawning a child whose Request reaches the Owner and stays
 * unanswered. `name` keeps the fake calls apart from any inherited ones, and the marker tells
 * the Owner's context from the child's, since a fork inherits it and a child never holds it.
 */
async function spawnChildThatRequests(
	host: TestOwnerHost,
	options: { name: string; prompt: string; question: string; reply: string; onDelivery(context: Context): void },
): Promise<void> {
	const session = host.runtime.session;
	const { name, prompt, question, reply, onDelivery } = options;
	const ownerId = session.sessionId;
	const route: FauxResponseFactory = context => {
		const text = JSON.stringify(context.messages);
		if (text.includes(OWNER_CONTEXT_MARKER)) {
			if (text.includes(question)) {
				onDelivery(context);
				return fauxAssistantMessage(reply);
			}
			return text.includes(`spawn-${name}-child`)
				? fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id: `wait-${name}-child` }), { stopReason: "toolUse" })
				: fauxAssistantMessage(fauxToolCall("agent_spawn", {
					title: "Fixture request", request: "Ask the Owner for a decision.",
				}, { id: `spawn-${name}-child` }), { stopReason: "toolUse" });
		}
		return text.includes(`request-${name}-decision`)
			? fauxAssistantMessage("Waiting for the decision.")
			: fauxAssistantMessage(fauxToolCall("agent_message", {
				title: "Fixture request", operation: "request", targetAgent: ownerId, question,
			}, { id: `request-${name}-decision` }), { stopReason: "toolUse" });
	};
	host.model.setResponses(Array.from({ length: 20 }, () => route));
	await session.prompt(prompt);
	await session.waitForIdle();
}

/**
 * A source Owner whose history names a child Agent, the Owner's own Creation Request to it,
 * and a Request the child addressed to the Owner that the Owner left unanswered.
 */
async function ownerWithInheritedAgentAndRequests(host: TestOwnerHost): Promise<ScopeFacts> {
	let incomingRequestId: string | undefined;
	await spawnChildThatRequests(host, {
		name: "scope", prompt: OWNER_CONTEXT_MARKER, question: "Which scope decision?", reply: "Noted; deciding later.",
		onDelivery: context => { incomingRequestId = findDeliveredRequest(context)?.requestMessageId; },
	});
	assert.ok(incomingRequestId, "the child's Request reached the source Owner");
	const spawn = host.runtime.session.sessionManager.getEntries().flatMap(entry =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "spawn-scope-child"
			? [entry.message.details as { agentId: string; requestMessageId: string }] : [])[0];
	assert.ok(spawn);
	return { childId: spawn.agentId, creationRequestId: spawn.requestMessageId, incomingRequestId };
}

const CURRENT_QUESTION = "Which fork decision?";
const ATTENTION_PREFIX = "user:Outstanding Requests.";

/** A fork whose history holds an inherited Delivery, and which now owes a Request of its own. */
async function forkOwingCurrentRequest(host: TestOwnerHost) {
	await ownerWithInheritedAgentAndRequests(host);
	await host.runtime.fork(host.runtime.session.sessionManager.getLeafId()!, { position: "at" });
	const deliveryTurns: Context[] = [];
	await spawnChildThatRequests(host, {
		name: "current", prompt: "Start the current child.", question: CURRENT_QUESTION, reply: "Noted in the fork.",
		onDelivery: context => { deliveryTurns.push(structuredClone(context)); },
	});
	assert.ok(deliveryTurns.length > 0, "the child's Request reached the fork");
	return { fork: host.runtime.session, deliveryTurn: deliveryTurns[0]! };
}

test("a fresh Delivery on a fork stays the newest message, right after the Request attention", { timeout: 15_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	try {
		const { deliveryTurn: { messages } } = await forkOwingCurrentRequest(host);
		assert.match(textOf(messages.at(-1)!), new RegExp(CURRENT_QUESTION));
		const shape = shapeOf(messages);
		assert.ok(shape.at(-2)!.startsWith(ATTENTION_PREFIX), "the attention sits directly above the Delivery");
		assert.equal(shape.filter(line => line.startsWith(ATTENTION_PREFIX)).length, 1);
		assert.ok(shape.indexOf(BOUNDARY) >= 0 && shape.indexOf(BOUNDARY) < shape.length - 2);
	} finally {
		await host.runtime.dispose();
	}
});

test("Request attention stays below the boundary on a branch off an entry under an inherited Delivery", { timeout: 15_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	try {
		const { fork } = await forkOwingCurrentRequest(host);
		await fork.navigateTree(messageEntryId(fork, "Noted; deciding later."), { summarize: false });
		const request = await promptAndRecord(fork, host, "Branch work.", "Branch reply.");
		const shape = shapeOf(request.messages);
		const boundaryAt = shape.indexOf(BOUNDARY);
		assert.equal(shape[boundaryAt - 1], "assistant:Noted; deciding later.");
		assert.equal(shape.filter(line => line.startsWith(ATTENTION_PREFIX)).length, 1);
		const attentionAt = shape.findIndex(line => line.startsWith(ATTENTION_PREFIX));
		assert.ok(attentionAt > boundaryAt, `attention at ${attentionAt} lands above the boundary at ${boundaryAt}`);
	} finally {
		await host.runtime.dispose();
	}
});

test("a fork rejects tools that name an inherited Agent or Request and creates no obligation", { timeout: 10_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, processVisibleModel: true });
	try {
		const { childId, creationRequestId, incomingRequestId } = await ownerWithInheritedAgentAndRequests(host);
		await host.runtime.fork(host.runtime.session.sessionManager.getLeafId()!, { position: "at" });
		const fork = host.runtime.session;
		const attempts: Array<[string, Record<string, unknown>]> = [
			["agent_observe", { operation: "status", agentId: childId }],
			["agent_message", { operation: "answer", requestId: incomingRequestId, answer: "Answering across the cutoff." }],
			["agent_message", { operation: "send", targetAgent: childId, content: "Do not cross the cutoff." }],
			["agent_message", { operation: "cancel", requestMessageId: creationRequestId, reason: "Not mine." }],
		];
		const accepted: string[] = [];
		const rejections: string[] = [];
		const durableBefore = fork.sessionManager.getEntries().filter(entry => entry.type !== "message").length;
		for (const [index, [tool, input]] of attempts.entries()) {
			try {
				const result = await executeRegisteredTool(fork, tool, `scope-attempt-${index}`, input);
				accepted.push(`${tool} ${JSON.stringify(input)} -> ${JSON.stringify(result.details)}`);
			} catch (error) {
				rejections.push(`${tool}: ${(error as Error).message}`);
			}
		}
		assert.deepEqual(accepted, []);
		// agent_wait needs a live Run, so drive it from a model turn: outside one it
		// would fail for that reason alone and prove nothing about scope.
		for (const requestId of [creationRequestId, incomingRequestId]) {
			const resultText: string[] = [];
			host.model.setResponses([
				() => fauxAssistantMessage(fauxToolCall("agent_wait", { requestMessageIds: [requestId] }, { id: `wait-${requestId}` }), { stopReason: "toolUse" }),
				context => {
					const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === `wait-${requestId}`);
					resultText.push(result ? `${(result as { isError: boolean }).isError}:${textOf(result)}` : "no result");
					return fauxAssistantMessage("Wait attempt over.");
				},
			]);
			await fork.prompt(`Wait on ${requestId}.`);
			await fork.waitForIdle();
			assert.match(resultText[0] ?? "", /^true:.*(unknown_identity|wrong_workflow|wrong_participant)/s, `agent_wait ${requestId}`);
		}
		assert.equal(fork.sessionManager.getEntries().filter(entry => entry.type !== "message").length, durableBefore);
		const obligations = await executeAndCommitRegisteredTool(fork, "agent_observe", "scope-obligations", { operation: "obligations" });
		assert.deepEqual(obligations.details, { requests: [] });
	} finally {
		await host.runtime.dispose();
	}
});
