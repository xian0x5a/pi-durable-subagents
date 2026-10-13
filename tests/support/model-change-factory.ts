import type { RunSupervisor } from "../../src/coordination/run-supervision.ts";

/** For Run supervision tests that never change a model. */
export const unusedModelChanges: ConstructorParameters<typeof RunSupervisor>[0]["models"] = {
	resolveModelChange: () => Promise.reject(new Error("unexpected model change")),
	recordModelChange: () => {
		throw new Error("unexpected model change");
	},
};
