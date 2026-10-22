import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PI_TEST_ENVIRONMENT_MARKER = "PI_DURABLE_SUBAGENTS_TEST_ENVIRONMENT";

// A production Agent child also has a bootstrap marker, so only this test-owned
// marker permits descendants to reuse an inherited Pi configuration directory.
function establishPiTestAgentDirectory(): string {
	if (process.env[PI_TEST_ENVIRONMENT_MARKER] === "1") {
		const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
		if (!inheritedAgentDir) {
			throw new Error("invalid_pi_test_environment: PI_CODING_AGENT_DIR is required");
		}
		return inheritedAgentDir;
	}

	const agentDir = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env[PI_TEST_ENVIRONMENT_MARKER] = "1";
	process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
	return agentDir;
}

// Pi treats every provider whose credential variable is set as authenticated
// (see pi-ai's env-api-keys). Credentials inherited from a developer shell or a
// cloud agent sandbox would list real providers beside the test provider, and
// could let a test call a paid API. Matched by convention so new providers
// following it are covered; the named exceptions are Pi's other sources.
const PROVIDER_CREDENTIAL_VARIABLE =
	/(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^(ANTHROPIC|AWS|GOOGLE_CLOUD|GCLOUD)_|^(GOOGLE_APPLICATION_CREDENTIALS|HF_TOKEN|COPILOT_GITHUB_TOKEN)$/;

function removeProviderCredentials(): void {
	for (const name of Object.keys(process.env)) {
		if (PROVIDER_CREDENTIAL_VARIABLE.test(name)) delete process.env[name];
	}
}

removeProviderCredentials();
export const PI_TEST_AGENT_DIR = establishPiTestAgentDirectory();
