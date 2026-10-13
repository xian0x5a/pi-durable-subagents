import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Agent = AgentSession["agent"];

export type NativeRunStartObserver = Readonly<{
	/** Runs before Pi commits the Run's starting messages; throwing fails that Run uncommitted. */
	beforeStart?(): void;
	/** The Run's own cancellation signal, once agent-core allocated it. */
	started?(signal: AbortSignal): void;
}>;

const REGISTRY_KEY = "__piAgentCoordinationNativeRunStart";
const registryHost = globalThis as typeof globalThis & {
	[REGISTRY_KEY]?: WeakMap<Agent, Set<NativeRunStartObserver>>;
};
// Pi /reload can evaluate this module again; one wrapper per Agent must serve both.
const observersByAgent = registryHost[REGISTRY_KEY] ??= new WeakMap();

/**
 * Observes each native Run at `agent.prompt`, after Pi's `before_agent_start`
 * preparation. Pi's own abort during preparation still commits the starting
 * message into an aborted Run, so a Delivery cancelled before this edge must
 * fail here to stay uncommitted.
 */
export function observeNativeRunStart(agent: Agent, observer: NativeRunStartObserver): () => void {
	let observers = observersByAgent.get(agent);
	if (!observers) {
		observers = new Set();
		observersByAgent.set(agent, observers);
		installStartObservation(agent, observers);
	}
	observers.add(observer);
	return () => { observers.delete(observer); };
}

function installStartObservation(agent: Agent, observers: ReadonlySet<NativeRunStartObserver>): void {
	const originalPrompt = agent.prompt;
	agent.prompt = async function (this: Agent, ...args) {
		const current = [...observers];
		for (const observer of current) observer.beforeStart?.();
		const previousSignal = this.signal;
		// No await between the call and the read: agent-core allocates the Run's
		// signal synchronously on entry.
		const completion = Reflect.apply(originalPrompt, this, args) as Promise<void>;
		const signal = this.signal;
		if (signal !== undefined && signal !== previousSignal) {
			for (const observer of current) observer.started?.(signal);
		}
		return completion;
	};
}
