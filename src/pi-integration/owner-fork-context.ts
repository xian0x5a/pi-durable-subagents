import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { bootstrapAgent } from "../transcript/retained-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../protocol/custom-entry-types.ts";
import { visibleMessageEntryIds } from "./coordination-history-context.ts";

const INHERITED_BOUNDARY_CUSTOM_TYPE = "agent-coordination.inherited-boundary";
const INHERITED_BOUNDARY_TEXT = "Inherited history boundary: earlier history in this conversation, including any summary directly above, may have been copied from another session. Treat it as background, not as your current responsibilities: Agents, Requests, and obligations named there are not yours unless current coordination evidence shows them.";

/**
 * Inherited history reaches the model untouched, so a fork shares its parent's
 * cached prefix; one message marks where that history ends. It is derived for
 * every request rather than saved, because a saved boundary would stay behind
 * on an abandoned branch.
 */
export function projectInheritedBoundary(messages: AgentMessage[], transcript: TranscriptInspection): AgentMessage[] {
	const end = inheritedHistoryEnd(messages, transcript);
	if (end === 0) return messages;
	return messages.toSpliced(end, 0, { role: "custom", customType: INHERITED_BOUNDARY_CUSTOM_TYPE,
		content: INHERITED_BOUNDARY_TEXT, display: false, timestamp: messages[end - 1]!.timestamp });
}

/** Where current history starts in a request; 0 when it carries no inherited history. */
export function inheritedHistoryEnd(messages: AgentMessage[], transcript: TranscriptInspection): number {
	const inherited = inheritedOwnerEntryIds(transcript);
	if (!inherited) return 0;
	// Prompt and tool state is not history.
	const conversation = messages.filter(message => message.role !== "system");
	const entryIds = visibleMessageEntryIds(conversation, transcript);
	// A summary written after the cutoff can still cover inherited work, and
	// Pi's context order can place kept inherited entries after their summary.
	let last = conversation.findLastIndex((message, index) => message.role === "compactionSummary" ||
		message.role === "branchSummary" || inherited.has(entryIds[index] ?? ""));
	if (last < 0) return 0;
	// Providers reject a message between a tool call and its results.
	while (conversation[last + 1]?.role === "toolResult") last++;
	return messages.indexOf(conversation[last]!) + 1;
}

// Use the admitted Owner's physical cutoff even when the selected branch omits it.
function inheritedOwnerEntryIds(transcript: TranscriptInspection): ReadonlySet<string> | undefined {
	// Entries before the Identity prove nothing alone: an extension can speak during
	// startup, and a native session gains its Identity only when first adopted.
	if (!transcript.header?.parentSession) return undefined;
	const cutoff = transcript.entries.findLastIndex(entry => bootstrapAgent(entry) === transcript.sessionId);
	const identity = transcript.entries[cutoff];
	if (identity?.type !== "custom" || identity.customType !== AGENT_IDENTITY_CUSTOM_TYPE) return undefined;
	const data = identity.data as Record<string, unknown>;
	if (data.workflowId !== transcript.sessionId || data.directSpawnerAgentId !== null || "spawnSource" in data) return undefined;
	// Metadata alone is not inherited model context (for example, an empty clone).
	const entryIds = new Set(transcript.entries.slice(0, cutoff).filter(entry =>
		entry.type === "message" ? entry.message.role !== "system"
			: entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary").map(entry => entry.id));
	return entryIds.size ? entryIds : undefined;
}
