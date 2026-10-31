import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import { inspectCoordinationRejections } from "../src/protocol/replay-rejection.ts";
import { createTestOwnerHost, type TestOwnerHost } from "./support/pi-host.ts";
import {
	BOUNDARY, INHERITED_SHAPE, boundaryCount, boundaryIndex, dropTool, forkedOwner, identityEntryIds, messageEntryId,
	promptAndRecord, rolesOf, sessionHoldsNoBoundary, shapeOf, systemEntryId, textOf,
} from "./support/owner-fork-boundary.ts";

/** The provider sees the same bytes up to the boundary: the parent's request, then the reply it got. */
function assertKeepsParentPrefix(first: Context, parent: Context): void {
	const parentLength = parent.messages.length;
	assert.deepEqual(rolesOf(first.messages).slice(0, parentLength), rolesOf(parent.messages));
	// Text, not deep equality: a head Pi rebuilt holds equal fields in another order.
	assert.equal(JSON.stringify(first.messages.slice(0, parentLength)), JSON.stringify(parent.messages));
	assert.equal(boundaryIndex(first.messages), parentLength + 1);
}

test("a fork's first request keeps its parent's cache prefix, native tool calls included", { timeout: 10_000 }, async t => {
	const { host, fork, parentLastRequest } = await forkedOwner(t);
	try {
		const first = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
		assertKeepsParentPrefix(first, parentLastRequest);
		// The request has no prompt or tools fields; both travel in its leading system message.
		const head = first.messages[0]!;
		assert.ok(head.role === "system");
		assert.ok(head.sections?.preamble, "the prefix holds the real system prompt");
		assert.ok(head.toolsAdded?.some(tool => tool.name === "agent_message"), "the prefix holds the real tools");
		assert.equal(first.messages.some(message => /\^ /.test(textOf(message))), false);
	} finally {
		await host.runtime.dispose();
	}
});

test("a fork's first request keeps a parent's mid-conversation system message in place", { timeout: 10_000 }, async t => {
	const { host, fork, parentLastRequest } = await forkedOwner(t, {}, source => dropTool(source, "workflow_resume"));
	try {
		assert.deepEqual(rolesOf(parentLastRequest.messages), ["system", "user", "assistant", "assistant", "toolResult", "system", "user"]);
		const first = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
		assertKeepsParentPrefix(first, parentLastRequest);
	} finally {
		await host.runtime.dispose();
	}
});

test("a tool change inside a fork stays inline and leaves the sent prefix alone", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		const first = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
		dropTool(fork, "agent_control");
		const second = await promptAndRecord(fork, host, "More fork work.", "More fork reply.");
		assert.equal(JSON.stringify(second.messages.slice(0, first.messages.length)), JSON.stringify(first.messages));
		assert.deepEqual(rolesOf(second.messages).slice(first.messages.length), ["assistant", "system", "user"]);
		const update = second.messages.at(-2)!;
		assert.ok(update.role === "system");
		assert.deepEqual(update.toolsRemoved?.map(tool => tool.name), ["agent_control"]);
	} finally {
		await host.runtime.dispose();
	}
});

test("after a fork the model sees inherited history, one boundary, then the new prompt", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		const first = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
		assert.deepEqual(shapeOf(first.messages), [...INHERITED_SHAPE, BOUNDARY, "user:Fork work."]);
		assert.equal(boundaryCount(first.messages), 1);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

test("branching off an inherited entry puts the boundary at the branch point", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		await fork.navigateTree(messageEntryId(fork, "Source first reply."), { summarize: false });
		const request = await promptAndRecord(fork, host, "Branch work.", "Branch reply.");
		assert.deepEqual(shapeOf(request.messages), [
			"user:Source start.", "assistant:Source first reply.", BOUNDARY, "user:Branch work.",
		]);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

const BARE_BRANCH_TARGETS: Array<[string, (fork: AgentSession) => string]> = [
	["the session's first entry", fork => fork.sessionManager.getEntries()[0]!.id],
	["the source Identity", fork => identityEntryIds(fork)[0]!],
	["Pi's inherited system message", systemEntryId],
];

for (const [name, target] of BARE_BRANCH_TARGETS) {
	test(`a bare branch at ${name} gets no boundary`, { timeout: 10_000 }, async t => {
		const { host, fork } = await forkedOwner(t);
		try {
			await fork.navigateTree(target(fork), { summarize: false });
			const request = await promptAndRecord(fork, host, "Fresh branch work.", "Fresh branch reply.");
			assert.deepEqual(shapeOf(request.messages), ["user:Fresh branch work."]);
		} finally {
			await host.runtime.dispose();
		}
	});
}

test("a branch summary written after the cutoff is followed by the boundary", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		await promptAndRecord(fork, host, "Current work.", "Current reply.");
		host.model.setResponses([() => fauxAssistantMessage("BRANCH_SUMMARY_MARKER")]);
		await fork.navigateTree(messageEntryId(fork, "Source first reply."), { summarize: true });
		const request = await promptAndRecord(fork, host, "After summary.", "After summary reply.");
		const shape = shapeOf(request.messages);
		const summaryAt = shape.findIndex(line => line.includes("BRANCH_SUMMARY_MARKER"));
		assert.ok(summaryAt >= 0, "the branch summary reaches the model");
		assert.equal(shape.filter(line => line === BOUNDARY).length, 1);
		assert.deepEqual(shape.slice(summaryAt + 1), [BOUNDARY, "user:After summary."]);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

test("a summarized navigation to the source Identity is followed by the boundary", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		host.model.setResponses([() => fauxAssistantMessage("BRANCH_SUMMARY_MARKER")]);
		await fork.navigateTree(identityEntryIds(fork)[0]!, { summarize: true });
		const request = await promptAndRecord(fork, host, "New work.", "New reply.");
		const shape = shapeOf(request.messages);
		assert.match(shape[0]!, /BRANCH_SUMMARY_MARKER/);
		assert.deepEqual(shape.slice(1), [BOUNDARY, "user:New work."]);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

const COMPACTION_SETTINGS = { compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 } };

/** Replaces Pi's summarizer so a compaction keeps exactly the entry the test names. */
function compactionKeeping(choice: { firstKeptEntryId?: string }): ExtensionFactory {
	return pi => {
		pi.on("session_before_compact", event => choice.firstKeptEntryId === undefined ? undefined : ({
			compaction: {
				summary: "EXTENSION_SUMMARY_MARKER",
				firstKeptEntryId: choice.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	};
}

test("a native compaction that keeps only current entries is followed directly by the boundary", { timeout: 10_000 }, async t => {
	const { host, fork } = await forkedOwner(t, {
		settings: COMPACTION_SETTINGS,
	});
	try {
		await promptAndRecord(fork, host, "Current work.", "Current reply.");
		const summarize = () => fauxAssistantMessage("NATIVE_SUMMARY_MARKER");
		host.model.setResponses([summarize, summarize]);
		await fork.compact();
		const request = await promptAndRecord(fork, host, "After compaction.", "After compaction reply.");
		const shape = shapeOf(request.messages);
		const summaryAt = shape.findIndex(line => line.includes("NATIVE_SUMMARY_MARKER"));
		assert.equal(summaryAt, 0);
		// Pi's cut with keepRecentTokens=1 lands inside the current turn, on its reply.
		assert.equal(shape[1], BOUNDARY);
		assert.equal(shape.filter(line => line === BOUNDARY).length, 1);
		assert.deepEqual(shape.slice(2), ["assistant:Current reply.", "user:After compaction."]);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

test("an extension compaction keeping inherited entries puts the boundary after them", { timeout: 10_000 }, async t => {
	const choice: { firstKeptEntryId?: string } = {};
	const { host, fork } = await forkedOwner(t, {
		additionalExtensionFactories: [compactionKeeping(choice)],
		settings: COMPACTION_SETTINGS,
	});
	try {
		await promptAndRecord(fork, host, "Current work.", "Current reply.");
		choice.firstKeptEntryId = messageEntryId(fork, "Source work.");
		await fork.compact();
		const request = await promptAndRecord(fork, host, "After compaction.", "After compaction reply.");
		assert.deepEqual(shapeOf(request.messages).slice(1), [
			"user:Source work.", "assistant:Source final reply.", BOUNDARY,
			"user:Current work.", "assistant:Current reply.", "user:After compaction.",
		]);
		assert.match(shapeOf(request.messages)[0]!, /EXTENSION_SUMMARY_MARKER/);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

test("an extension compaction keeping only current entries is followed directly by the boundary", { timeout: 10_000 }, async t => {
	const choice: { firstKeptEntryId?: string } = {};
	const { host, fork } = await forkedOwner(t, {
		additionalExtensionFactories: [compactionKeeping(choice)],
		settings: COMPACTION_SETTINGS,
	});
	try {
		await promptAndRecord(fork, host, "Current work.", "Current reply.");
		choice.firstKeptEntryId = messageEntryId(fork, "Current work.");
		await fork.compact();
		const request = await promptAndRecord(fork, host, "After compaction.", "After compaction reply.");
		const shape = shapeOf(request.messages);
		assert.match(shape[0]!, /EXTENSION_SUMMARY_MARKER/);
		assert.deepEqual(shape.slice(1), [BOUNDARY, "user:Current work.", "assistant:Current reply.", "user:After compaction."]);
		sessionHoldsNoBoundary(fork);
	} finally {
		await host.runtime.dispose();
	}
});

// Equal in every field, so only its position in the transcript tells the copies apart.
const DUPLICATE_PROMPT = { role: "user" as const, content: "Duplicate prompt.", timestamp: 1 };

const DUPLICATE_COMPACTIONS = [
	{ fate: "removed", firstKept: "Current work.", compactFirst: false, afterSummary: [BOUNDARY] },
	{ fate: "kept", firstKept: "Duplicate prompt.", compactFirst: true, afterSummary: ["user:Duplicate prompt.", BOUNDARY] },
];

for (const { fate, firstKept, compactFirst, afterSummary } of DUPLICATE_COMPACTIONS) {
	test(`the boundary stays above the current copy of an inherited prompt compaction ${fate}`, { timeout: 10_000 }, async t => {
		const choice: { firstKeptEntryId?: string } = {};
		const host = await createTestOwnerHost(t, piAgentCoordination, {
			persistent: true, additionalExtensionFactories: [compactionKeeping(choice)], settings: COMPACTION_SETTINGS,
		});
		try {
			const source = host.runtime.session;
			await promptAndRecord(source, host, "Source start.", "Source first reply.");
			await host.runtime.fork(source.sessionManager.appendMessage(DUPLICATE_PROMPT), { position: "at" });
			const fork = host.runtime.session;
			const writeCurrentCopy = async () => {
				await promptAndRecord(fork, host, "Current work.", "Current reply.");
				fork.sessionManager.appendMessage(structuredClone(DUPLICATE_PROMPT));
			};
			const compact = async () => {
				choice.firstKeptEntryId = messageEntryId(fork, firstKept);
				await fork.compact();
			};
			for (const step of compactFirst ? [compact, writeCurrentCopy] : [writeCurrentCopy, compact]) await step();
			const request = await promptAndRecord(fork, host, "Next work.", "Next reply.");
			assert.equal(rolesOf(request.messages)[0], "system");
			const shape = shapeOf(request.messages);
			assert.match(shape[0]!, /EXTENSION_SUMMARY_MARKER/);
			assert.deepEqual(shape.slice(1), [
				...afterSummary, "user:Current work.", "assistant:Current reply.", "user:Duplicate prompt.", "user:Next work.",
			]);
		} finally {
			await host.runtime.dispose();
		}
	});
}

function observeResult(toolCallId: string) {
	return {
		role: "toolResult" as const, toolCallId, toolName: "agent_observe",
		content: [{ type: "text" as const, text: "{}" }], isError: false, timestamp: Date.now(),
	};
}

const LATE_RESULTS: Array<[string, string[], string[]]> = [
	["all", [], ["parallel-1", "parallel-2"]],
	["some", ["parallel-1"], ["parallel-2"]],
];

for (const [name, inheritedResults, lateResults] of LATE_RESULTS) {
	test(`the boundary waits for ${name} of an inherited call's results written after the cutoff`, { timeout: 10_000 }, async t => {
		let inheritedTail!: string;
		const { host } = await forkedOwner(t, {}, source => {
			inheritedTail = source.sessionManager.appendMessage(fauxAssistantMessage([
				fauxToolCall("agent_observe", { operation: "status" }, { id: "parallel-1" }),
				fauxToolCall("agent_observe", { operation: "status" }, { id: "parallel-2" }),
			], { stopReason: "toolUse" }));
			for (const toolCallId of inheritedResults) inheritedTail = source.sessionManager.appendMessage(observeResult(toolCallId));
		});
		try {
			await host.runtime.fork(inheritedTail, { position: "at" });
			const fork = host.runtime.session;
			for (const toolCallId of lateResults) fork.sessionManager.appendMessage(observeResult(toolCallId));
			const request = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
			assert.deepEqual(shapeOf(request.messages).slice(-5), [
				"calls:agent_observe#parallel-1,agent_observe#parallel-2", "result:parallel-1", "result:parallel-2",
				BOUNDARY, "user:Fork work.",
			]);
		} finally {
			await host.runtime.dispose();
		}
	});
}

const MARK = "MARK";

const MARKED_RECORDS: Array<[string, number]> = [
	["an exact duplicate of an inherited call", 1],
	["a call sharing an inherited native ID", 2],
];

for (const [name, timestamp] of MARKED_RECORDS) {
	test(`the boundary sits directly above a \`!\` mark on ${name}`, { timeout: 10_000 }, async t => {
		const invalidCall = (stamp: number) => ({
			...fauxAssistantMessage(fauxToolCall("agent_message", { operation: "request", question: "Missing title" }, { id: "same-native-id" }), { stopReason: "toolUse" }),
			timestamp: stamp,
		});
		const invalidResult = (stamp: number) => ({
			role: "toolResult" as const, toolCallId: "same-native-id", toolName: "agent_message",
			content: [{ type: "text" as const, text: "Result" }], isError: false, timestamp: stamp,
		});
		let inheritedTail!: string;
		const { host } = await forkedOwner(t, {}, source => {
			source.sessionManager.appendMessage(invalidCall(1));
			inheritedTail = source.sessionManager.appendMessage(invalidResult(1));
		});
		try {
			await host.runtime.fork(inheritedTail, { position: "at" });
			const fork = host.runtime.session;
			fork.sessionManager.appendMessage(invalidCall(timestamp));
			fork.sessionManager.appendMessage(invalidResult(timestamp));
			const request = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
			const shape = shapeOf(request.messages).map(line => line.startsWith("user:! ") ? MARK : line);
			assert.deepEqual(shape.slice(-5), [
				"calls:agent_message#same-native-id", "result:same-native-id", BOUNDARY, MARK, "user:Fork work.",
			]);
		} finally {
			await host.runtime.dispose();
		}
	});
}

test("a fork-provenance entry from an older version stays inert", { timeout: 15_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	let reopened: TestOwnerHost | undefined;
	try {
		const identityEntryId = identityEntryIds(fork).at(-1)!;
		fork.sessionManager.appendCustomEntry("agent-coordination.fork-provenance", {
			version: 1, agentId: fork.sessionId, identityEntryId,
			origins: [{ entryId: messageEntryId(fork, "Source start."), agentId: "source-owner" }],
		});
		const sessionFile = fork.sessionManager.getSessionFile()!;
		await host.runtime.dispose();
		reopened = await createTestOwnerHost(t, piAgentCoordination, { cwd: host.cwd, agentDir: host.services.agentDir, sessionFile });
		const session = reopened.runtime.session;
		const transcript = transcriptFromSessionManager(session.sessionManager).inspect();
		assert.deepEqual(inspectCoordinationRejections(transcript, session.sessionId), []);
		assert.deepEqual(inspectMessageDeliveries({ transcript, recipientAgentId: session.sessionId }), []);
		assert.equal(session.getActiveToolNames().includes("agent_spawn"), true);
		const request = await promptAndRecord(session, reopened, "Fork work.", "Fork reply.");
		assert.deepEqual(shapeOf(request.messages), [...INHERITED_SHAPE, BOUNDARY, "user:Fork work."]);
		assert.doesNotMatch(JSON.stringify(request.messages), /fork-provenance/);
	} finally {
		await reopened?.runtime.dispose();
		await host.runtime.dispose();
	}
});

test("reload and a second fork each keep exactly one boundary and store none", { timeout: 15_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
		await fork.reload();
		const afterReload = await promptAndRecord(fork, host, "After reload.", "Reload reply.");
		assert.deepEqual(shapeOf(afterReload.messages), [
			...INHERITED_SHAPE, BOUNDARY, "user:Fork work.", "assistant:Fork reply.", "user:After reload.",
		]);
		await host.runtime.fork(fork.sessionManager.getLeafId()!, { position: "at" });
		const secondFork = host.runtime.session;
		assert.notEqual(secondFork, fork);
		const afterSecondFork = await promptAndRecord(secondFork, host, "Second fork work.", "Second fork reply.");
		assert.deepEqual(shapeOf(afterSecondFork.messages), [
			...INHERITED_SHAPE, "user:Fork work.", "assistant:Fork reply.", "user:After reload.",
			"assistant:Reload reply.", BOUNDARY, "user:Second fork work.",
		]);
		for (const session of [fork, secondFork]) {
			sessionHoldsNoBoundary(session);
			assert.doesNotMatch(await readFile(session.sessionManager.getSessionFile()!, "utf8"), /Inherited history boundary:/);
		}
	} finally {
		await host.runtime.dispose();
	}
});

test("re-forking a branch that holds no fork Identity puts the boundary after that branch's work", { timeout: 15_000 }, async t => {
	const { host, fork } = await forkedOwner(t);
	try {
		const forkIdentity = identityEntryIds(fork).at(-1)!;
		await fork.navigateTree(messageEntryId(fork, "Source first reply."), { summarize: false });
		await promptAndRecord(fork, host, "Branch work.", "Branch reply.");
		assert.equal(fork.sessionManager.getBranch().some(entry => entry.id === forkIdentity), false);
		await fork.reload();
		const afterReload = await promptAndRecord(fork, host, "After reload.", "Reload reply.");
		assert.deepEqual(shapeOf(afterReload.messages), [
			"user:Source start.", "assistant:Source first reply.", BOUNDARY,
			"user:Branch work.", "assistant:Branch reply.", "user:After reload.",
		]);
		await host.runtime.fork(fork.sessionManager.getLeafId()!, { position: "at" });
		const secondFork = host.runtime.session;
		assert.notEqual(secondFork, fork);
		const request = await promptAndRecord(secondFork, host, "Second fork work.", "Second fork reply.");
		assert.deepEqual(shapeOf(request.messages), [
			"user:Source start.", "assistant:Source first reply.", "user:Branch work.", "assistant:Branch reply.",
			"user:After reload.", "assistant:Reload reply.", BOUNDARY, "user:Second fork work.",
		]);
		sessionHoldsNoBoundary(secondFork);
	} finally {
		await host.runtime.dispose();
	}
});

test("a fresh Owner without inherited history gets no boundary", { timeout: 10_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true });
	try {
		const first = await promptAndRecord(host.runtime.session, host, "Fresh work.", "Fresh reply.");
		assert.equal(boundaryCount(first.messages), 0);
		const second = await promptAndRecord(host.runtime.session, host, "More fresh work.", "More fresh reply.");
		assert.equal(boundaryCount(second.messages), 0);
	} finally {
		await host.runtime.dispose();
	}
});

test("a fresh Owner never gets a boundary from a message an earlier extension sent at session_start", { timeout: 10_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [pi => {
			pi.on("session_start", () => pi.sendMessage({ customType: "earlier-extension.notice", content: "Earlier notice.", display: true }));
		}],
	});
	try {
		const session = host.runtime.session;
		assert.equal(session.sessionManager.getHeader()?.parentSession, undefined);
		const entries = session.sessionManager.getEntries();
		const noticeAt = entries.findIndex(entry => entry.type === "custom_message" && entry.customType === "earlier-extension.notice");
		assert.ok(noticeAt >= 0 && noticeAt < entries.findIndex(entry => entry.id === identityEntryIds(session)[0]));
		const first = await promptAndRecord(session, host, "Fresh work.", "Fresh reply.");
		assert.deepEqual(shapeOf(first.messages), ["user:Earlier notice.", "user:Fresh work."]);
		const second = await promptAndRecord(session, host, "More fresh work.", "More fresh reply.");
		assert.deepEqual(shapeOf(second.messages), [
			"user:Earlier notice.", "user:Fresh work.", "assistant:Fresh reply.", "user:More fresh work.",
		]);
	} finally {
		await host.runtime.dispose();
	}
});

test("a native session later opened by this package keeps the user's own history without a boundary", { timeout: 10_000 }, async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-durable-subagents-native-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const native = SessionManager.create(cwd, join(cwd, "sessions"));
	native.appendMessage({ role: "user", content: "Native question.", timestamp: 1 });
	native.appendMessage(fauxAssistantMessage("Native reply."));
	const host = await createTestOwnerHost(t, piAgentCoordination, { cwd, sessionFile: native.getSessionFile()! });
	try {
		const session = host.runtime.session;
		assert.equal(session.sessionManager.getHeader()?.parentSession, undefined);
		const identityAt = session.sessionManager.getEntries().findIndex(entry => entry.id === identityEntryIds(session)[0]);
		assert.ok(identityAt > session.sessionManager.getEntries().findIndex(entry => entry.id === messageEntryId(session, "Native reply.")));
		const request = await promptAndRecord(session, host, "Owner work.", "Owner reply.");
		assert.deepEqual(shapeOf(request.messages), ["user:Native question.", "assistant:Native reply.", "user:Owner work."]);
	} finally {
		await host.runtime.dispose();
	}
});

test("a fork before the first prompt copies no history, so its compaction summary gets no boundary", { timeout: 10_000 }, async t => {
	const host = await createTestOwnerHost(t, piAgentCoordination, { persistent: true, settings: COMPACTION_SETTINGS });
	try {
		const source = host.runtime.session;
		await promptAndRecord(source, host, "Source start.", "Source first reply.");
		await host.runtime.fork(messageEntryId(source, "Source start."), { position: "before" });
		const fork = host.runtime.session;
		assert.notEqual(fork, source);
		assert.ok(fork.sessionManager.getHeader()?.parentSession, "Pi records this session as a fork");
		const first = await promptAndRecord(fork, host, "Fork work.", "Fork reply.");
		assert.deepEqual(shapeOf(first.messages), ["user:Fork work."]);
		const summarize = () => fauxAssistantMessage("NATIVE_SUMMARY_MARKER");
		host.model.setResponses([summarize, summarize]);
		await fork.compact();
		const request = await promptAndRecord(fork, host, "After compaction.", "After compaction reply.");
		const shape = shapeOf(request.messages);
		assert.match(shape[0]!, /NATIVE_SUMMARY_MARKER/);
		assert.deepEqual(shape.slice(1), ["assistant:Fork reply.", "user:After compaction."]);
	} finally {
		await host.runtime.dispose();
	}
});
