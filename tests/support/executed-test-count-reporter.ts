import type { TestEvent } from "node:test/reporters";

// Sums the tests each file actually ran, for run-test-suite.ts to read back.
// Only the per-file summaries count: the run-wide summary also counts each test
// file as a test, so it reports one test even when a name pattern selects none.
export default async function* executedTestCountReporter(
	events: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
	let executedTests = 0;
	for await (const event of events) {
		if (event.type === "test:summary" && event.data.file !== undefined) {
			executedTests += event.data.counts.tests;
		}
	}
	yield String(executedTests);
}
