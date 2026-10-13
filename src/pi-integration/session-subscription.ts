import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Subscribes to an AgentSession so unsubscribing is safe inside its own event.
 *
 * Pi's `_emit` walks its live listener array and Pi's unsubscribe splices that
 * array, so removing a listener mid-emit would hide the event from the next
 * listener. Unsubscribe stops delivery at once and leaves the array after the
 * current emit.
 */
export function subscribeSession(
	session: AgentSession,
	listener: (event: AgentSessionEvent) => void,
): () => void {
	let subscribed = true;
	const unsubscribe = session.subscribe(event => {
		if (subscribed) listener(event);
	});
	return () => {
		if (!subscribed) return;
		subscribed = false;
		queueMicrotask(unsubscribe);
	};
}
