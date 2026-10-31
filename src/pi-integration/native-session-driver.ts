import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";

import type { AgentRunFailure, AgentRuntimeDelivery } from "../runtime/agent-runtime-host.ts";
import { RetainedRuntimeQueue, type RuntimeQueue } from "../runtime/retained-runtime-queue.ts";
import { observeNativeRunStart } from "./native-run-start.ts";
import { type PendingNativeStarts, pendingNativeStarts } from "./pending-native-starts.ts";
import { subscribeSession } from "./session-subscription.ts";

/** The single Run-outcome vocabulary of the Owner Runtime, the child bridge, and the Control wire. */
export const NATIVE_RUN_OUTCOMES = ["completed", "aborted", "error"] as const;
export type NativeRunOutcome = (typeof NATIVE_RUN_OUTCOMES)[number];

const MODEL_FAILURE_PROVENANCE = "native-session-driver";

export type NativeRunEnd = Readonly<{
	outcome: NativeRunOutcome;
	willRetry: boolean;
	failure?: AgentRunFailure;
}>;

export type NativeSessionEvent =
	| Readonly<{ type: "run_started" }>
	| Readonly<{ type: "run_ended" } & NativeRunEnd>
	| Readonly<{ type: "run_settled" }>
	| Readonly<{ type: "compaction_changed"; compacting: boolean }>
	| Readonly<{ type: "state_changed" }>;

/** Wraps the single dispatch attempt of one Delivery. */
export type TurnAdmission = Readonly<{
	admit<T>(attempt: (checkpoint: () => void) => Promise<T>): Promise<T>;
	/** Runs the synchronous native submission; `fence` fails it before Pi sees it. */
	submit?<T>(submission: () => T, fence: () => void): T | Promise<T>;
	/** The submission passed a fence inside Pi and may now start a native Run. */
	accepted?(): void;
}>;

export type NativeDeliveryOptions = Readonly<{
	/** A user Delivery is provable only when it sets no queue mode; see `deliver`. */
	proveCommit?: boolean;
	admission?: TurnAdmission;
	/** Cancels the Delivery until Pi accepts its submission. */
	signal?: AbortSignal;
}>;

export type NativeDeliveryDispatch = Readonly<{
	/** Settles with Pi's dispatch: Run completion, or native queue acceptance. */
	completion: Promise<void>;
	/** Pi accepted the submission; `runActive` samples the session right after. */
	preflight: Promise<Readonly<{ runActive: boolean }>>;
	transcriptCommit?: Promise<boolean>;
}>;

type CustomDelivery = Extract<AgentRuntimeDelivery, { kind: "custom" }>;
type SessionMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];
type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];
type NativeSubmission = Readonly<{ completion: Promise<void>; preflight: Promise<void> }>;
type AcceptedAttempt = Readonly<{ completion: Promise<void>; runActive: boolean }>;
/** An idle start held back while another native start call is open. */
type HeldStart = Readonly<{ nativeStartsChanged: Promise<void> }>;
/** One submission's last cancellation check, at its own native Run start. */
type StartFence = {
	accepted: boolean;
	/** The submission's own native start passed, or it can start none. */
	spent: boolean;
	readonly fence: () => void;
	/** Releases Deliveries held behind this submission's possible start. */
	releaseHold: () => void;
};

const IMMEDIATE_ADMISSION: TurnAdmission = { admit: attempt => attempt(() => undefined) };

/**
 * Drives one Pi AgentSession binding generation for both Agent Runtimes: the
 * Owner's in-process Runtime and each child bridge generation.
 */
export class NativeSessionDriver {
	readonly #session: AgentSession;
	readonly #listeners = new Set<(event: NativeSessionEvent) => void>();
	readonly #retainedQueue: RetainedRuntimeQueue;
	readonly #proofs = new Set<TranscriptCommitProof>();
	readonly #pendingStarts: PendingNativeStarts;
	readonly #startFences = new AsyncLocalStorage<StartFence>();
	readonly #removeStartObserver: () => void;
	/** Submitted native calls not yet returned; each may still reach its start fence. */
	#submissionsInFlight = 0;
	#unsubscribeSession: (() => void) | undefined;
	#compacting: boolean;
	/** Advances on every compaction edge, so only the latest may report the end. */
	#compactionEdge = 0;
	#disposed = false;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#compacting = session.isCompacting;
		this.#retainedQueue = new RetainedRuntimeQueue(() => session.clearQueue());
		this.#pendingStarts = pendingNativeStarts(session);
		// Only the first native start inside a submission is its own Run; a later one
		// in the same async context, such as a deferred settlement action, is not.
		this.#removeStartObserver = observeNativeRunStart(session.agent, {
			beforeStart: () => {
				const startFence = this.#startFences.getStore();
				if (!startFence?.accepted || startFence.spent) return;
				startFence.spent = true;
				try {
					startFence.fence();
				} catch (error) {
					// Agent-core stays unstarted, so nothing may join until Pi stops
					// counting this Run as busy; settlement holds then take over.
					this.#releaseAtSettlement(startFence.releaseHold);
					throw error;
				}
				startFence.releaseHold();
			},
		});
	}

	deliver(delivery: AgentRuntimeDelivery, options: NativeDeliveryOptions = {}): NativeDeliveryDispatch {
		// A queued user message carries nothing that identifies it once Pi drains it,
		// so only the Run a user Delivery starts can prove it, by position.
		if (options.proveCommit && delivery.kind === "user" && delivery.deliverAs !== undefined) {
			throw new Error("queued_user_commit_unprovable: prove a user Delivery only when it starts its own Run");
		}
		const proof = options.proveCommit ? this.#createProof(delivery) : undefined;
		const accepted = this.#dispatch(delivery, options.admission ?? IMMEDIATE_ADMISSION, options, proof);
		const completion = accepted.then(attempt => attempt.completion);
		void completion.then(() => proof?.dispatchCompleted(), error => proof?.reject(error));
		const preflight = accepted.then(({ runActive }) => ({ runActive }));
		void preflight.catch(() => undefined);
		return { completion, preflight, ...(proof ? { transcriptCommit: proof.result } : {}) };
	}

	subscribe(listener: (event: NativeSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		// One session subscription serves every listener, so classification and
		// queue capture run once before any listener observes the Run end.
		this.#unsubscribeSession ??= subscribeSession(this.#session, event => this.#handleSessionEvent(event));
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size > 0) return;
			this.#unsubscribeSession?.();
			this.#unsubscribeSession = undefined;
		};
	}

	/** Returns native queued input together with input retained at a terminal error. */
	clearQueue(): RuntimeQueue {
		return this.#retainedQueue.clear();
	}

	queuedInputCount(): number {
		return this.#session.pendingMessageCount;
	}

	/**
	 * Starts and proves one custom Run only when nothing else could own the turn: a
	 * busy session never receives it, so it can never enter a native queue.
	 */
	async commitIdleCustom(
		message: CustomDelivery["message"],
		options: Omit<NativeDeliveryOptions, "proveCommit"> = {},
	): Promise<"busy" | "committed"> {
		if (!this.canStartIdleTurn()) return "busy";
		const dispatch = this.deliver({ kind: "custom", message, triggerTurn: true }, { ...options, proveCommit: true });
		if (!await dispatch.transcriptCommit) throw new Error("idle_custom_commit_missing: the started Run did not commit the exact Delivery");
		return "committed";
	}

	/**
	 * No native Run is active or preparing, and no native start call is still
	 * open in its input phase or settlement, which Pi counts as idle.
	 */
	canStartIdleTurn(): boolean {
		return this.#session.isIdle && !this.#pendingStarts.open;
	}

	isIdle(): boolean {
		return this.#session.isIdle;
	}

	/**
	 * Follows Pi's compaction edges, not its flag: the flag also covers branch
	 * summaries and outlives a failed automatic compaction.
	 */
	isCompacting(): boolean {
		return this.#compacting;
	}

	hasPendingActivity(): boolean {
		return this.#compacting || this.#session.isCompacting || this.#session.pendingMessageCount > 0;
	}

	/** The active Run's own cancellation signal. */
	cancellationSignal(): AbortSignal {
		const signal = this.#session.agent.signal;
		if (!signal) throw new Error("invariant_violation: current Agent Run has no cancellation signal");
		return signal;
	}

	abort(): Promise<void> {
		return this.#session.abort();
	}

	waitForIdle(): Promise<void> {
		return this.#session.waitForIdle();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		// A submission still preparing must meet its fence, which now fails it
		// uncommitted, as its rejected proof reports.
		if (this.#submissionsInFlight === 0) this.#removeStartObserver();
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		// An end edge still held dies with this generation, and the Owner outlives a reload.
		if (this.#compacting) this.#setCompacting(false);
		this.#listeners.clear();
		for (const proof of this.#proofs) proof.reject(new Error("native_session_driver_disposed"));
	}

	async #dispatch(
		delivery: AgentRuntimeDelivery,
		admission: TurnAdmission,
		options: NativeDeliveryOptions,
		proof: TranscriptCommitProof | undefined,
	): Promise<AcceptedAttempt> {
		for (;;) {
			const attempt = await admission.admit(checkpoint => this.#attempt(delivery, admission, options, proof, checkpoint));
			if (!("nativeStartsChanged" in attempt)) return attempt;
			// Wait outside admit: the open call's own hooks may need the gate the
			// admission held, so waiting inside it would deadlock both.
			await settledUnlessAborted(attempt.nativeStartsChanged, options.signal);
		}
	}

	async #attempt(
		delivery: AgentRuntimeDelivery,
		admission: TurnAdmission,
		options: NativeDeliveryOptions,
		proof: TranscriptCommitProof | undefined,
		checkpoint: () => void,
	): Promise<AcceptedAttempt | HeldStart> {
		const signal = options.signal;
		const fence = () => {
			if (this.#disposed) throw new Error("native_session_driver_disposed");
			checkpoint();
			signal?.throwIfAborted();
		};
		const startFence: StartFence = { accepted: false, spent: false, fence, releaseHold: () => undefined };
		const accept = () => {
			startFence.accepted = true;
			admission.accepted?.();
		};
		const preflightFence = () => {
			fence();
			accept();
		};
		const submission = (): NativeSubmission | HeldStart => this.#startFences.run(startFence, () => {
			fence();
			// Decide before watching: a hold can come from inside Pi's settlement
			// emit, whose agent_settled a new proof listener would still receive.
			const held = this.#heldStart(delivery);
			if (held) return held;
			proof?.begin();
			const native = this.#submit(delivery, startFence, preflightFence, accept, proof);
			// Counted as soon as Pi has it, so a dispose from here on keeps the fence.
			this.#submissionsInFlight++;
			const returned = () => {
				startFence.spent = true;
				startFence.releaseHold();
				if (--this.#submissionsInFlight === 0 && this.#disposed) this.#removeStartObserver();
			};
			void native.completion.then(returned, returned);
			return native;
		});
		const submitted = await (admission.submit ? admission.submit(submission, fence) : submission());
		if ("nativeStartsChanged" in submitted) return submitted;
		await Promise.race([submitted.preflight, submitted.completion]);
		checkpoint();
		return { completion: submitted.completion, runActive: !this.#session.isIdle };
	}

	/**
	 * Holds a Delivery that would start a Run beside another open native start
	 * call. It retries once that call starts its Run, which the Delivery then
	 * joins in its own queue mode, or closes, after which it may start one.
	 * - Settlement: Pi defers any start requested then, past this Delivery's await.
	 * - Input phase: a custom start would fail that prompt. A user prompt can
	 *   overlap it, as forwarded input replacing that very prompt must.
	 * Any Delivery, starting or joining, also waits while a fenced start
	 * prepares: if its fence fails it, agent-core never runs, and a joiner would
	 * be stranded in agent-core's queue.
	 */
	#heldStart(delivery: AgentRuntimeDelivery): HeldStart | undefined {
		const pending = this.#pendingStarts;
		// Before Run setup the fenced start is still in its input phase, which a
		// forwarded user Delivery must be able to overlap.
		if (this.#session.isStreaming && pending.fencedStartPreparing) return { nativeStartsChanged: pending.nextChange() };
		if (this.#session.isStreaming || (delivery.kind === "custom" && !delivery.triggerTurn)) return undefined;
		if (pending.pastInput || (delivery.kind === "custom" && pending.inInput)) {
			return { nativeStartsChanged: pending.nextChange() };
		}
		return undefined;
	}

	#releaseAtSettlement(release: () => void): void {
		const unsubscribe = subscribeSession(this.#session, event => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			release();
		});
	}

	#submit(
		delivery: AgentRuntimeDelivery,
		startFence: StartFence,
		preflightFence: () => void,
		accept: () => void,
		proof: TranscriptCommitProof | undefined,
	): NativeSubmission {
		if (delivery.kind === "custom") {
			const startsRun = delivery.triggerTurn && !this.#session.isStreaming;
			// Pi's sendCustomMessage, unlike prompt, would start a Run beside compaction.
			if (startsRun && this.#session.isCompacting) {
				throw new Error("custom_start_during_compaction: wait for compaction to finish and retry");
			}
			// Pi decides synchronously on entry whether a custom message starts a Run,
			// joins the active one, or waits, so the call itself is its acceptance.
			// A started Run gets Pi's own `before_agent_start` preparation.
			preflightFence();
			if (startsRun) startFence.releaseHold = this.#pendingStarts.holdForFencedStart();
			const completion = this.#session.sendCustomMessage(delivery.message, {
				triggerTurn: delivery.triggerTurn,
				...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
			});
			// Pi already appended or queued it; an extension Run started from those events is not its own.
			if (!startsRun) startFence.spent = true;
			return { completion, preflight: Promise.resolve() };
		}
		const content = typeof delivery.content === "string"
			? [{ type: "text" as const, text: delivery.content }]
			: delivery.content;
		const images = content.flatMap(part => part.type === "image" ? [part] : []);
		let resolvePreflight!: () => void;
		const preflight = new Promise<void>(resolve => { resolvePreflight = resolve; });
		// Its fence fails a cancelled start just as a custom one's does.
		if (!this.#session.isStreaming) startFence.releaseHold = this.#pendingStarts.holdForFencedStart();
		// The same submission Pi's sendUserMessage makes, plus preflight acceptance.
		const completion = this.#session.prompt(submittedUserText(delivery.content), {
			expandPromptTemplates: false,
			source: "extension",
			...(images.length === 0 ? {} : { images }),
			...(delivery.deliverAs === undefined ? {} : { streamingBehavior: delivery.deliverAs }),
			preflightResult(disposition) {
				// Pi reports a started Run outside its Run cleanup, so throwing here would
				// leave the session busy for good. The native start fence rejects a
				// cancelled Delivery inside the Run instead.
				if (disposition === "started") accept();
				else {
					startFence.spent = true;
					startFence.releaseHold();
					preflightFence();
				}
				proof?.userSubmissionAccepted(disposition);
				resolvePreflight();
			},
		});
		return { completion, preflight };
	}

	#createProof(delivery: AgentRuntimeDelivery): TranscriptCommitProof {
		const proof = new TranscriptCommitProof(this.#session, delivery, () => this.#proofs.delete(proof));
		this.#proofs.add(proof);
		return proof;
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#pendingStarts.runStarted();
			this.#emit({ type: "run_started" });
		} else if (event.type === "compaction_start") {
			this.#compactionEdge += 1;
			this.#setCompacting(true);
		} else if (event.type === "compaction_end") {
			// Pi emits the end edge for success, failure, and cancellation alike.
			void this.#finishCompaction(++this.#compactionEdge);
		} else if (event.type === "queue_update" || event.type === "thinking_level_changed") {
			this.#emit({ type: "state_changed" });
		} else if (event.type === "agent_end") {
			const runEnd = this.#classifyRunEnd(event);
			// Pi checks queued continuation right after this synchronous callback, and
			// listeners may await before suspending the Run. Capture terminal errors
			// first; deliberate stops and configured retries keep their native queue.
			if (runEnd.outcome === "error" && !runEnd.willRetry) this.#retainedQueue.capture();
			this.#emit({ type: "run_ended", ...runEnd });
		} else if (event.type === "agent_settled") this.#emit({ type: "run_settled" });
	}

	#classifyRunEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): NativeRunEnd {
		const assistant = event.messages.findLast(message => message.role === "assistant");
		if (assistant?.role !== "assistant" || assistant.stopReason !== "error") {
			const outcome = assistant?.role === "assistant" && assistant.stopReason === "aborted" ? "aborted" : "completed";
			return { outcome, willRetry: event.willRetry };
		}
		// Pi reports a request setup that its own abort signal abandoned as a model
		// error carrying the abort reason. Agent-core keeps the exact Run's controller
		// until its listeners settle, so this reads that Run's own cancellation.
		if (this.#session.agent.signal?.aborted === true) return { outcome: "aborted", willRetry: event.willRetry };
		return {
			outcome: "error",
			willRetry: event.willRetry,
			...(assistant.errorMessage === undefined
				? {}
				: { failure: { stage: "model", error: assistant.errorMessage, provenance: MODEL_FAILURE_PROVENANCE } }),
		};
	}

	/**
	 * Pi's interactive mode hands input queued during compaction to `session.prompt`
	 * inside `compaction_end`, before any public state shows it. Report the end only
	 * once that input resolved or its Run started, so a release check that follows
	 * sees the successor Run instead of an idle session.
	 */
	async #finishCompaction(edge: number): Promise<void> {
		// Wait out Pi's synchronous emit: later listeners may submit that input.
		await Promise.resolve();
		while (this.#pendingStarts.inInput || this.#pendingStarts.runStarting) {
			await this.#pendingStarts.nextChange();
		}
		if (!this.#disposed && edge === this.#compactionEdge) this.#setCompacting(false);
	}

	#setCompacting(compacting: boolean): void {
		this.#compacting = compacting;
		this.#emit({ type: "compaction_changed", compacting });
	}

	#emit(event: NativeSessionEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
}

/**
 * Proves that one Delivery reached the transcript. Turn-level entry IDs are not
 * visible on the session event surface, so `message_end` is only a wake-up: Pi
 * notifies listeners immediately before its synchronous append, and the entry is
 * read in the microtask after persistence. The Delivery's own message ending
 * without its entry settles false at once.
 *
 * A custom Delivery is its exact fields among entries new since dispatch. A user
 * Delivery carries no identity, and Pi's `input` handlers may rewrite its text,
 * so it is identified by position: once Pi reports that it started a Run, that
 * Run's first user message is this Delivery, and Pi persists that same object.
 */
class TranscriptCommitProof {
	readonly result: Promise<boolean>;
	readonly #session: AgentSession;
	readonly #delivery: AgentRuntimeDelivery;
	#existingEntryIds: ReadonlySet<string> = new Set();
	#userRunStarted = false;
	#ownUserMessage: SessionMessage | undefined;
	#unsubscribe: (() => void) | undefined;
	readonly #onFinished: () => void;
	#resolve!: (committed: boolean) => void;
	#reject!: (error: unknown) => void;
	#finished = false;

	constructor(session: AgentSession, delivery: AgentRuntimeDelivery, onFinished: () => void) {
		this.#session = session;
		this.#delivery = delivery;
		this.#onFinished = onFinished;
		this.result = new Promise<boolean>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		void this.result.catch(() => undefined);
	}

	/** Starts watching at one submission; only entries new since then can confirm. */
	begin(): void {
		this.#existingEntryIds = new Set(this.#session.sessionManager.getEntries().map(entry => entry.id));
		if (this.#unsubscribe) return;
		this.#unsubscribe = subscribeSession(this.#session, event => {
			if (event.type === "message_end") this.#messageEnded(event.message);
			// A user Delivery's own message ends before its Run settles, and another
			// Run's settlement says nothing about it.
			if (event.type === "agent_settled" && this.#delivery.kind === "custom") this.#settle();
		});
	}

	/** Pi decided a user Delivery's dispatch after its `input` handlers ran. */
	userSubmissionAccepted(disposition: PromptDisposition): void {
		if (disposition === "started") this.#userRunStarted = true;
		else if (disposition === "handled") this.#finish(() => this.#resolve(false));
		else throw new Error("invariant_violation: Pi queued a proven user Delivery that set no queue mode");
	}

	dispatchCompleted(): void {
		queueMicrotask(() => {
			if (this.#committed()) this.#finish(() => this.#resolve(true));
			// A submission Pi queued into the active Run commits when that Run takes it.
			else if (!this.#session.isStreaming) this.#finish(() => this.#resolve(false));
		});
	}

	reject(error: unknown): void {
		this.#finish(() => this.#reject(error));
	}

	#messageEnded(message: SessionMessage): void {
		if (message.role !== (this.#delivery.kind === "custom" ? "custom" : "user")) return;
		const ownMessage = this.#isOwnMessage(message);
		queueMicrotask(() => {
			if (this.#committed()) this.#finish(() => this.#resolve(true));
			// Pi's append already ran, so this exact message will never commit. Do
			// not wait for settlement: a forwarded human resume awaits this proof
			// while holding its Agent lane, and the Run's own agent_end hook waits
			// on that lane, so settlement would never arrive.
			else if (ownMessage) this.#finish(() => this.#resolve(false));
		});
	}

	#isOwnMessage(message: SessionMessage): boolean {
		if (this.#delivery.kind === "custom") return message.role === "custom" && matchesCustomFields(this.#delivery, message);
		if (!this.#userRunStarted || this.#ownUserMessage || message.role !== "user") return false;
		this.#ownUserMessage = message;
		return true;
	}

	#settle(): void {
		const committed = this.#committed();
		this.#finish(() => this.#resolve(committed));
	}

	#committed(): boolean {
		if (this.#finished) return false;
		const entries = this.#session.sessionManager.getEntries();
		const delivery = this.#delivery;
		if (delivery.kind === "custom") {
			return entries.some(entry => !this.#existingEntryIds.has(entry.id) &&
				entry.type === "custom_message" && matchesCustomFields(delivery, entry));
		}
		const ownUserMessage = this.#ownUserMessage;
		return ownUserMessage !== undefined &&
			entries.some(entry => entry.type === "message" && entry.message === ownUserMessage);
	}

	#finish(settlement: () => void): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#onFinished();
		settlement();
	}
}

function matchesCustomFields(
	delivery: CustomDelivery,
	candidate: Readonly<{ customType: string; content: unknown; display: boolean; details?: unknown }>,
): boolean {
	return candidate.customType === delivery.message.customType &&
		isDeepStrictEqual(candidate.content, delivery.message.content) &&
		candidate.display === delivery.message.display &&
		isDeepStrictEqual(candidate.details, "details" in delivery.message ? delivery.message.details : undefined);
}

function submittedUserText(content: Extract<AgentRuntimeDelivery, { kind: "user" }>["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

async function settledUnlessAborted(settled: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return settled;
	signal.throwIfAborted();
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([settled, aborted]);
	} finally { signal.removeEventListener("abort", onAbort); }
}
