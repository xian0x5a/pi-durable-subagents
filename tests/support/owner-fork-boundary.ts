import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { fauxAssistantMessage, type Context, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../../src/index.ts";
import { executeAndCommitRegisteredTool } from "./agent-session.ts";
import { createTestOwnerHost, type TestOwnerHost, type TestOwnerHostOptions } from "./pi-host.ts";

// Shared by the Owner fork boundary tests: a forked Owner whose model requests are captured.

const BOUNDARY_PREFIX = "Inherited history boundary:";
export const BOUNDARY = "BOUNDARY";
const WAIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1;

export type Message = Context["messages"][number];

export function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
}

/** Pi prepends a `system`-role message carrying tool guidance; it is not conversation. */
export function conversationOf(messages: readonly Message[]): Message[] {
	return messages.filter(message => (message.role as string) !== "system");
}

/** One readable line per model-visible message, with the boundary named. */
export function shapeOf(messages: readonly Message[]): string[] {
	return conversationOf(messages).map(message => {
		if (message.role === "toolResult") return `result:${message.toolCallId}`;
		if (message.role === "assistant") {
			const calls = message.content.flatMap(part => part.type === "toolCall" ? [`${part.name}#${part.id}`] : []);
			return calls.length > 0 ? `calls:${calls.join(",")}` : `assistant:${textOf(message)}`;
		}
		const text = textOf(message);
		return text.startsWith(BOUNDARY_PREFIX) ? BOUNDARY : `user:${text}`;
	});
}

function isBoundary(message: Message): boolean {
	return (message.role as string) !== "system" && message.role !== "assistant" && message.role !== "toolResult"
		&& textOf(message).startsWith(BOUNDARY_PREFIX);
}

export function boundaryCount(messages: readonly Message[]): number {
	return messages.filter(isBoundary).length;
}

/** The boundary's place in the provider request, where system messages hold positions too. */
export function boundaryIndex(messages: readonly Message[]): number {
	return messages.findIndex(isBoundary);
}

export function rolesOf(messages: readonly Message[]): string[] {
	return messages.map(message => message.role);
}

/** A fake model turn that keeps the Context the provider received. */
export function recording(requests: Context[], reply: string): FauxResponseFactory {
	return context => {
		requests.push(structuredClone(context));
		return fauxAssistantMessage(reply);
	};
}

export async function promptAndRecord(session: AgentSession, host: TestOwnerHost, text: string, reply: string): Promise<Context> {
	const requests: Context[] = [];
	host.model.setResponses([recording(requests, reply)]);
	await session.prompt(text);
	await session.waitForIdle();
	assert.equal(requests.length, 1);
	return requests[0]!;
}

export function messageEntryId(session: AgentSession, text: string): string {
	const entry = session.sessionManager.getEntries().find(candidate =>
		candidate.type === "message" && textOf(candidate.message as Message) === text);
	assert.ok(entry, `No entry with text ${text}`);
	return entry.id;
}

export function identityEntryIds(session: AgentSession): string[] {
	return session.sessionManager.getEntries().flatMap(entry =>
		entry.type === "custom" && entry.customType === "agent-coordination.identity" ? [entry.id] : []);
}

/** Pi's persisted prompt and tool state, which a fork copies with the rest of the prefix. */
export function systemEntryId(session: AgentSession): string {
	const entry = session.sessionManager.getEntries().find(candidate =>
		candidate.type === "message" && candidate.message.role === "system");
	assert.ok(entry, "No persisted system message");
	return entry.id;
}

/** A loadout change, which Pi records as a system message before the next prompt. */
export function dropTool(session: AgentSession, name: string): void {
	session.setActiveToolsByName(session.getActiveToolNames().filter(tool => tool !== name));
}

export function observeStatus(session: AgentSession, toolCallId: string) {
	return executeAndCommitRegisteredTool(session, "agent_observe", toolCallId, { operation: "status" });
}

export type InheritedFork = {
	host: TestOwnerHost;
	fork: AgentSession;
	/** The source Owner's last model request, before it was forked. */
	parentLastRequest: Context;
};

/**
 * A source Owner with native tool history, forked at its leaf. The source history is
 * user, assistant, agent_observe call and result, user, assistant.
 */
export async function forkedOwner(
	t: TestContext,
	options: TestOwnerHostOptions = {},
	extendSource: (source: AgentSession) => Promise<void> | void = () => {},
): Promise<InheritedFork> {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, ...options });
	const source = host.runtime.session;
	await promptAndRecord(source, host, "Source start.", "Source first reply.");
	await observeStatus(source, "inherited-observe");
	await extendSource(source);
	const parentLastRequest = await promptAndRecord(source, host, "Source work.", "Source final reply.");
	await host.runtime.fork(source.sessionManager.getLeafId()!, { position: "at" });
	assert.notEqual(host.runtime.session, source);
	return { host, fork: host.runtime.session, parentLastRequest };
}

export const INHERITED_SHAPE = [
	"user:Source start.",
	"assistant:Source first reply.",
	"calls:agent_observe#inherited-observe",
	"result:inherited-observe",
	"user:Source work.",
	"assistant:Source final reply.",
];

export function sessionHoldsNoBoundary(session: AgentSession): void {
	assert.doesNotMatch(JSON.stringify(session.sessionManager.getEntries()), /Inherited history boundary:/);
}

export async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}
