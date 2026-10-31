import {
	estimateTokens,
	type AgentSession,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import {
	workingZonePreparationThreshold,
} from "../policy/working-zone-preparation.ts";
import { subscribeSession } from "../pi-integration/session-subscription.ts";
import { isRuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";
import {
	MESSAGE_DELIVERY_CUSTOM_TYPE,
} from "../protocol/message-delivery.ts";
import type { WorkingZonePreparation } from "../runtime/agent-runtime-host.ts";

/** Owns turn preparation policy beside one exact child AgentSession generation. */
export class ChildTurnCompactionGateway {
	#disposed = false;
	#activeAdmissions = 0;
	#admissionTail: Promise<void> = Promise.resolve();
	#activeDeliveryId: string | undefined;
	#preparingWorkingZone = false;
	readonly #generationAbort = new AbortController();
	readonly #cancelledDeliveryIds = new Set<string>();
	readonly #nativeAdmissions = new Map<number, () => void>();
	readonly #session: AgentSession;
	readonly #warn: (message: string) => void;

	constructor(
		session: AgentSession,
		warn: (message: string) => void = (message) => console.warn(message),
	) {
		this.#session = session;
		this.#warn = warn;
	}

	get signal(): AbortSignal {
		return this.#generationAbort.signal;
	}

	beforeCompaction(
		event: SessionBeforeCompactEvent,
	): { cancel: true } | undefined {
		if (this.#disposed || event.reason !== "threshold") return undefined;
		// A live Run signal means Pi is compacting between a tool result and the
		// next response, which needs the room now rather than at the next turn.
		if (
			this.#session.agent.signal !== undefined ||
			this.#activeAdmissions > 0 ||
			this.#session.agent.hasQueuedMessages()
		) return undefined;
		return { cancel: true };
	}

	admit<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.#admissionTail.then(async () => {
			this.#assertCurrentGeneration();
			this.#activeAdmissions += 1;
			try {
				return await operation();
			} finally {
				this.#activeAdmissions -= 1;
			}
		});
		this.#admissionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	admitDelivery<T>(
		deliveryId: string,
		operation: (checkpoint: () => void) => T | Promise<T>,
	): Promise<T> {
		return this.admit(async () => {
			this.#assertDeliveryCurrent(deliveryId);
			this.#activeDeliveryId = deliveryId;
			try {
				const result = await operation(() => this.#assertDeliveryCurrent(deliveryId));
				this.#assertDeliveryCurrent(deliveryId);
				return result;
			} catch (error) {
				this.#assertDeliveryCurrent(deliveryId);
				throw error;
			} finally {
				if (this.#activeDeliveryId === deliveryId) this.#activeDeliveryId = undefined;
			}
		});
	}

	cancelDelivery(deliveryId: string): void {
		this.#cancelledDeliveryIds.add(deliveryId);
		// Only Working-Zone Preparation compacts for a Delivery; any other running
		// compaction is Pi's own and may be why the Delivery is still waiting.
		if (this.#activeDeliveryId === deliveryId && this.#preparingWorkingZone) {
			this.#session.abortCompaction();
		}
	}

	shouldDiscardActiveDeliveryInput(): boolean {
		return this.#disposed ||
			(this.#activeDeliveryId !== undefined &&
				this.#cancelledDeliveryIds.has(this.#activeDeliveryId));
	}

	completeDelivery(deliveryId: string): void {
		this.#cancelledDeliveryIds.delete(deliveryId);
	}

	async reserveNativeTurn(submissionSequence: number): Promise<void> {
		if (this.#nativeAdmissions.has(submissionSequence)) {
			throw new Error(`child_native_turn_already_admitted: ${submissionSequence}`);
		}
		const release = await this.#reserveAdmission();
		this.#nativeAdmissions.set(submissionSequence, release);
	}

	completeNativeTurn(submissionSequence: number): void {
		const release = this.#nativeAdmissions.get(submissionSequence);
		if (!release) return;
		this.#nativeAdmissions.delete(submissionSequence);
		release();
	}

	async waitForCompaction(): Promise<void> {
		this.#assertCurrentGeneration();
		if (!this.#session.isCompacting) return;
		await new Promise<void>((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const finish = (settlement: () => void) => {
				unsubscribe();
				this.#generationAbort.signal.removeEventListener("abort", abort);
				settlement();
			};
			const abort = () => finish(() => reject(
				new Error("child_turn_compaction_gateway_disposed"),
			));
			unsubscribe = subscribeSession(this.#session, (event) => {
				if (event.type === "compaction_end") finish(resolve);
			});
			// Pi's isCompacting also covers branch summaries, which emit no
			// compaction_end but do wake idle waiters when they finish.
			void this.#session.waitForIdle().then(() => finish(resolve));
			this.#generationAbort.signal.addEventListener("abort", abort, { once: true });
			if (!this.#session.isCompacting) finish(resolve);
		});
		this.#assertCurrentGeneration();
	}

	/**
	 * Native threshold compaction is not checked here: Pi runs it when the admitted
	 * custom turn starts, with this model's settings and its true trigger.
	 */
	async prepareWorkingZone(preparation: WorkingZonePreparation): Promise<void> {
		this.#assertCurrentGeneration();
		if (!this.#session.isIdle || !this.#session.autoCompactionEnabled) return;
		const usage = this.#session.getContextUsage();
		if (!usage || usage.tokens === null) return;

		const incomingRequestTokens = estimateTokens({
			role: "custom",
			customType: MESSAGE_DELIVERY_CUSTOM_TYPE,
			content: JSON.stringify({
				messages: [preparation.prospectiveRequest],
			}),
			display: true,
			timestamp: 0,
		});
		const effectiveThreshold = workingZonePreparationThreshold({
			...preparation.intent,
			...(isRuntimeThinkingLevel(this.#session.thinkingLevel)
				? { thinking: this.#session.thinkingLevel }
				: {}),
			contextWindow: usage.contextWindow,
			incomingRequestTokens,
		});
		if (usage.tokens <= effectiveThreshold) return;

		try {
			await this.#compactForTurnPreparation(
				workingZoneCompactionInstructions(
					preparation.prospectiveRequest.question,
				),
			);
		} catch (error) {
			this.#warn(
				`Working-Zone Preparation failed; continuing Request Delivery: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		this.#assertCurrentGeneration();
	}

	async #compactForTurnPreparation(customInstructions: string): Promise<void> {
		let aborted: boolean | undefined;
		const unsubscribe = subscribeSession(this.#session, (event) => {
			if (event.type === "compaction_end" && event.reason === "manual") {
				aborted ??= event.aborted;
			}
		});
		this.#preparingWorkingZone = true;
		try {
			await this.#session.compact(customInstructions);
		} catch (error) {
			// Pi rejects every extension cancellation but reports it as aborted.
			// Extensions cancel to hand off to their own turn, and also to keep an
			// existing checkpoint after their own compaction fails. Honor Pi's
			// outcome, not error text or extension-specific intent.
			if (!aborted) throw error;
		} finally {
			this.#preparingWorkingZone = false;
			unsubscribe();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generationAbort.abort();
		if (this.#activeAdmissions > 0 && this.#session.isCompacting) {
			this.#session.abortCompaction();
		}
		for (const release of this.#nativeAdmissions.values()) release();
		this.#nativeAdmissions.clear();
	}

	async #reserveAdmission(): Promise<() => void> {
		let releaseHold!: () => void;
		let resolveAcquired!: () => void;
		let rejectAcquired!: (error: unknown) => void;
		const acquired = new Promise<void>((resolve, reject) => {
			resolveAcquired = resolve;
			rejectAcquired = reject;
		});
		const hold = this.#admissionTail.then(() => {
			this.#assertCurrentGeneration();
			this.#activeAdmissions += 1;
			resolveAcquired();
			return new Promise<void>((resolve) => {
				let released = false;
				releaseHold = () => {
					if (released) return;
					released = true;
					this.#activeAdmissions -= 1;
					resolve();
				};
			});
		}).catch((error: unknown) => {
			rejectAcquired(error);
			throw error;
		});
		this.#admissionTail = hold.then(
			() => undefined,
			() => undefined,
		);
		await acquired;
		return () => releaseHold();
	}

	#assertDeliveryCurrent(deliveryId: string): void {
		this.#assertCurrentGeneration();
		if (this.#cancelledDeliveryIds.has(deliveryId)) {
			throw new Error(`child_turn_admission_cancelled: ${deliveryId}`);
		}
	}

	#assertCurrentGeneration(): void {
		if (this.#disposed) {
			throw new Error("child_turn_compaction_gateway_disposed");
		}
	}
}

function workingZoneCompactionInstructions(prospectiveQuestion: string): string {
	return [
		"Use the prospective Request below only to choose which existing context to preserve.",
		"<prospective_request>",
		escapeXmlText(prospectiveQuestion),
		"</prospective_request>",
		"The Request has not committed to this transcript. Do not include or paraphrase it in the summary, and do not state or imply that this Agent received it.",
	].join("\n");
}

function escapeXmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
