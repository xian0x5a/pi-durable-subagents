import type { KeybindingHints } from "@earendil-works/pi-coding-agent";

/** Pi's injected key formatters, as the host renders a binding with no configured keys. */
export const keybindingHints: KeybindingHints = {
	keyText: () => "",
	keyHint: (_keybinding, description) => description,
};
