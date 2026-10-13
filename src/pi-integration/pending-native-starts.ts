import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";

/**
 * Tracks native `prompt` and `sendCustomMessage` calls Pi has not finished
 * with. Pi counts a session busy only from Run setup until it emits
 * `agent_settled`, yet the call that starts a Run stays open around both edges
 * while the session reports idle:
 * - before: a prompt's `input` hooks run first, and a custom Run started then
 *   makes that prompt fail with "Agent is already processing";
 * - after: Pi defers a Run requested during settlement and returns at once, so
 *   the requester never observes the Run it caused.
 */
export class PendingNativeStarts {
	#inInput = 0;
	#pastInput = 0;
	#fencedPreparing = 0;
	#notifyChange: (() => void) | undefined;
	#change: Promise<void> | undefined;

	constructor(session: AgentSession) {
		const originalPrompt = session.prompt;
		session.prompt = (text, options) => {
			if (runsExtensionCommand(session, text, options)) return originalPrompt.call(session, text, options);
			const call = this.#open("input");
			return call.track(() => originalPrompt.call(session, text, {
				...options,
				preflightResult: disposition => {
					// A handled or queued prompt starts no Run; a started one stays open until it settles.
					if (disposition === "started") call.leaveInput();
					else call.close();
					options?.preflightResult?.(disposition);
				},
			}));
		};
		const originalSendCustomMessage = session.sendCustomMessage;
		session.sendCustomMessage = (message, options) =>
			this.#open("pastInput").track(() => originalSendCustomMessage.call(session, message, options));
	}

	/** Some native start call is still open. */
	get open(): boolean {
		return this.#inInput + this.#pastInput > 0;
	}

	/** A prompt is still in its `input` hooks. */
	get inInput(): boolean {
		return this.#inInput > 0;
	}

	/** A call past its input phase is still open; on an idle session it is settling. */
	get pastInput(): boolean {
		return this.#pastInput > 0;
	}

	/** A start its own cancellation fence may still fail at native start is preparing. */
	get fencedStartPreparing(): boolean {
		return this.#fencedPreparing > 0;
	}

	/**
	 * Marks one fenced start as preparing. Release once its fence passed, or
	 * once Pi settled the Run a failed fence left unstarted: anything queued
	 * into agent-core before then would wait for an unrelated Run.
	 */
	holdForFencedStart(): () => void {
		this.#fencedPreparing++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#fencedPreparing--;
			this.#changed();
		};
	}

	/** Settles when a call opens, changes phase or closes, or a fenced start is released. */
	nextChange(): Promise<void> {
		return this.#change ??= new Promise(resolve => { this.#notifyChange = resolve; });
	}

	#open(phase: "input" | "pastInput") {
		let current: typeof phase | "closed" = phase;
		const count = (delta: number) => {
			if (current === "input") this.#inInput += delta;
			else if (current === "pastInput") this.#pastInput += delta;
		};
		count(1);
		// A Run Pi starts from settlement opens a call; a held joiner may now join it.
		this.#changed();
		const move = (next: typeof current) => {
			if (current === "closed" || current === next) return;
			count(-1);
			current = next;
			count(1);
			this.#changed();
		};
		const close = () => move("closed");
		return {
			leaveInput: () => move("pastInput"),
			close,
			track(call: () => Promise<void>): Promise<void> {
				let completion: Promise<void>;
				try {
					completion = call();
				} catch (error) {
					close();
					throw error;
				}
				void completion.then(close, close);
				return completion;
			},
		};
	}

	#changed(): void {
		const notify = this.#notifyChange;
		this.#change = undefined;
		this.#notifyChange = undefined;
		notify?.();
	}
}

/**
 * Pi runs a registered extension command before any input phase, and the
 * command starts no Run itself; one held open, like a selector, must not hold
 * idle starts. Mirrors Pi's own command dispatch in `prompt`.
 */
function runsExtensionCommand(session: AgentSession, text: string, options: PromptOptions | undefined): boolean {
	if (options?.expandPromptTemplates === false || !text.startsWith("/")) return false;
	const nameEnd = text.indexOf(" ");
	return session.extensionRunner.getCommand(text.slice(1, nameEnd === -1 ? undefined : nameEnd)) !== undefined;
}

const REGISTRY_KEY = "__piAgentCoordinationPendingNativeStarts";
const registryHost = globalThis as typeof globalThis & {
	[REGISTRY_KEY]?: WeakMap<AgentSession, PendingNativeStarts>;
};
// Owner reload and Pi /reload can evaluate this module again; one wrapper per session serves all.
const pendingBySession = registryHost[REGISTRY_KEY] ??= new WeakMap();

export function pendingNativeStarts(session: AgentSession): PendingNativeStarts {
	let pending = pendingBySession.get(session);
	if (!pending) {
		pending = new PendingNativeStarts(session);
		pendingBySession.set(session, pending);
	}
	return pending;
}
