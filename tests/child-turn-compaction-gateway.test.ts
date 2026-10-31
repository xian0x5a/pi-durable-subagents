import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import { ChildTurnCompactionGateway } from "../src/process-runtime/child-turn-compaction-gateway.ts";
import type { WorkingZonePreparation } from "../src/runtime/agent-runtime-host.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

const preparation: WorkingZonePreparation = {
	intent: { workScale: "large", contextDependence: "low" },
	prospectiveRequest: {
		title: "Fixture request",
		kind: "request",
		requestMessageId: "prepared-request",
		fromAgentId: "requester-agent",
		question: "Use the acquired parser context and compare x < y & y > z.",
	},
};

function fakeSession(options: {
	tokens: number | null;
	autoCompactionEnabled?: boolean;
	compactError?: Error;
}) {
	const compactInstructions: Array<string | undefined> = [];
	const session = {
		isCompacting: false,
		abortCompaction() {},
		// Pi's cancellation classification is exercised against real Pi below.
		subscribe: () => () => {},
		isIdle: true,
		autoCompactionEnabled: options.autoCompactionEnabled ?? true,
		thinkingLevel: "high",
		getContextUsage: () => ({
			tokens: options.tokens,
			contextWindow: 200_000,
			percent: options.tokens === null ? null : options.tokens / 2_000,
		}),
		compact: async (customInstructions?: string) => {
			compactInstructions.push(customInstructions);
			if (options.compactError) throw options.compactError;
			return {
				summary: "prepared",
				firstKeptEntryId: "entry",
				tokensBefore: options.tokens ?? 0,
			};
		},
	} as unknown as AgentSession;
	return { session, compactInstructions };
}

test("each working-zone admission calls the active strategy once with prospective relevance guidance", async () => {
	const { session, compactInstructions } = fakeSession({ tokens: 100_000 });
	const warnings: string[] = [];
	const gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

	await gateway.prepareWorkingZone(preparation);

	assert.equal(compactInstructions.length, 1);
	assert.match(
		compactInstructions[0] ?? "",
		/<prospective_request>\nUse the acquired parser context and compare x &lt; y &amp; y &gt; z\.\n<\/prospective_request>/,
	);
	assert.match(compactInstructions[0] ?? "", /has not committed to this transcript/);
	assert.match(compactInstructions[0] ?? "", /Do not include or paraphrase it/);
	assert.deepEqual(warnings, []);

	await gateway.prepareWorkingZone(preparation);
	assert.equal(compactInstructions.length, 2);
});

test("working-zone preparation skips disabled automatic compaction and unknown usage", async () => {
	for (const options of [
		{ tokens: 100_000, autoCompactionEnabled: false },
		{ tokens: null },
	] as const) {
		const { session, compactInstructions } = fakeSession(options);
		const gateway = new ChildTurnCompactionGateway(session);
		await gateway.prepareWorkingZone(preparation);
		assert.deepEqual(compactInstructions, []);
	}
});

test("optional below-native failure warns and continues without another attempt", async () => {
	const { session, compactInstructions } = fakeSession({
		tokens: 100_000,
		compactError: new Error("optional strategy failed"),
	});
	const warnings: string[] = [];
	const gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

	await gateway.prepareWorkingZone(preparation);

	assert.equal(compactInstructions.length, 1);
	assert.deepEqual(warnings, [
		"Working-Zone Preparation failed; continuing Request Delivery: optional strategy failed",
	]);
});

test("Runtime-generation disposal fences a prepared admission after compaction returns", async () => {
	const { session, compactInstructions } = fakeSession({ tokens: 100_000 });
	let finishCompaction!: () => void;
	(session as unknown as { compact(customInstructions?: string): Promise<unknown> }).compact =
		(customInstructions?: string) => {
			compactInstructions.push(customInstructions);
			return new Promise<void>((resolve) => {
				finishCompaction = resolve;
			});
		};
	const gateway = new ChildTurnCompactionGateway(session);
	const admission = gateway.admitDelivery("prepared-run", () =>
		gateway.prepareWorkingZone(preparation)
	);
	while (compactInstructions.length === 0) await new Promise((resolve) => setImmediate(resolve));
	gateway.dispose();
	finishCompaction();
	await assert.rejects(admission, /child_turn_compaction_gateway_disposed/);
});

const preparationPaths = [
	{ name: "optional working zone", tokens: 120_000 },
	{ name: "mandatory working zone", tokens: 190_000 },
] as const;

const PI_COMPACTION_SETTINGS = { compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 24 } };

/** A real Pi session whose compaction strategy is one extension handler. */
async function piSession(
	t: TestContext,
	tokens: number,
	strategy: (
		event: SessionBeforeCompactEvent,
	) => SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>,
): Promise<{ session: AgentSession; attempts: () => number }> {
	let attempts = 0;
	const host = await createUnboundTestOwnerHost(t, (pi) => {
		pi.on("session_before_compact", (event) => {
			if (event.reason === "manual") attempts += 1;
			return strategy(event);
		});
	}, { settings: PI_COMPACTION_SETTINGS });
	const session = host.session;
	for (let index = 0; index < 3; index += 1) {
		session.sessionManager.appendMessage({
			role: "user", content: "Prior context. ".repeat(200), timestamp: Date.now(),
		});
		session.sessionManager.appendMessage(fauxAssistantMessage("Prior response."));
	}
	session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
	session.getContextUsage = () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 });
	return { session, attempts: () => attempts };
}

test("every caller waiting on one compaction resumes when it ends", async (t) => {
	let releaseCompaction!: () => void;
	const compactionReleased = new Promise<void>((resolve) => {
		releaseCompaction = resolve;
	});
	const { session } = await piSession(t, 100_000, async () => {
		await compactionReleased;
		return { cancel: true };
	});
	const gateway = new ChildTurnCompactionGateway(session);
	const compaction = session.compact().catch(() => undefined);
	while (!session.isCompacting) await new Promise((resolve) => setImmediate(resolve));

	const resumed: string[] = [];
	const waiters = ["first", "second"].map((name) =>
		gateway.waitForCompaction().then(() => resumed.push(name))
	);
	releaseCompaction();
	await compaction;
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(resumed, ["first", "second"]);
	await Promise.all(waiters);
});

for (const path of preparationPaths) {
	// Extensions cancel for unrelated intents, such as handing off to their own
	// turn or keeping an existing checkpoint after a failed remote compaction.
	test(`${path.name} honors an extension's cancellation as Pi's outcome without warning or failure`, async (t) => {
		const { session, attempts } = await piSession(t, path.tokens, () => ({ cancel: true }));
		const warnings: string[] = [];
		const gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

		await gateway.admitDelivery("run", () =>
			gateway.prepareWorkingZone(preparation)
		);

		assert.equal(attempts(), 1);
		assert.deepEqual(warnings, []);
	});

	test(`${path.name} does not infer cancellation from an error string`, async () => {
		const { session } = fakeSession({
			tokens: path.tokens,
			compactError: new Error("Compaction cancelled"),
		});
		const warnings: string[] = [];
		const gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

		await gateway.prepareWorkingZone(preparation);

		assert.deepEqual(warnings, [
			"Working-Zone Preparation failed; continuing Request Delivery: Compaction cancelled",
		]);
	});

	for (const invalidation of ["owner cancellation", "generation disposal"] as const) {
		test(`${path.name} preserves ${invalidation} when Pi reports cancellation`, async (t) => {
			let gateway!: ChildTurnCompactionGateway;
			const { session } = await piSession(t, path.tokens, () => {
				if (invalidation === "owner cancellation") gateway.cancelDelivery("run");
				else gateway.dispose();
				return { cancel: true };
			});
			const warnings: string[] = [];
			gateway = new ChildTurnCompactionGateway(session, (warning) => warnings.push(warning));

			await assert.rejects(
				gateway.admitDelivery("run", () => gateway.prepareWorkingZone(preparation)),
				invalidation === "owner cancellation"
					? /child_turn_admission_cancelled: run/
					: /child_turn_compaction_gateway_disposed/,
			);
			assert.deepEqual(warnings, []);
		});
	}
}
