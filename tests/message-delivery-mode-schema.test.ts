import "./support/supervised-run.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxToolCall, validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { Check } from "typebox/value";
import piAgentCoordination from "../src/index.ts";
import { coordinationToolSchemas } from "../src/tools/coordination-tool-catalogue.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { agentControlProtocol } from "../src/control/agent-control-protocol.ts";

const parameters = coordinationToolSchemas.agent_message;
const tool = { name: "agent_message", description: "Coordinate", parameters };
const baseInputs = [
	{ operation: "send", targetAgent: "recipient", content: "Information" },
	{ operation: "request", targetAgent: "recipient", title: "Review", question: "Review the change" },
];

// $id is a platform fact: Gemini rejects a reference inside a schema that declares one.
// The other keywords are project policy so that every transport reads the same
// declaration: some strip definitions while keeping references, strict constrained
// sampling rejects references outright, and a reference makes presentation
// provider-dependent (Gemini expands it, DeepSeek leaves the pointer to the model).
const resolutionKeywords = ["$id", "$ref", "$defs", "definitions", "$anchor", "$schema"];

function nodes(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(nodes);
	if (!value || typeof value !== "object") return [];
	return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}

function resolutionKeywordsIn(value: unknown): string[] {
	return nodes(value).flatMap(node => resolutionKeywords.filter(key => Object.hasOwn(node, key)));
}

test("both authoring operations carry the same terse delivery mode union", async (t) => {
	const schema = JSON.parse(JSON.stringify(parameters));
	assert.deepEqual(resolutionKeywordsIn(schema), []);
	const fields = schema.anyOf
		.filter((branch: { properties: Record<string, unknown> }) => branch.properties.deliveryMode)
		.map((branch: { properties: Record<string, unknown> }) => branch.properties.deliveryMode);
	assert.equal(fields.length, 2);
	// The schema repeats every field both authoring operations accept, so the long rule
	// text lives in the delivery_modes tool guidance instead of here.
	assert.deepEqual(fields[1], fields[0]);
	const field = fields[0] as { anyOf?: { const?: string }[]; description?: string };
	assert.deepEqual(field.anyOf?.map(variant => variant.const), ["deferred", "steer", "background"]);
	assert.match(String(field.description), /defaults to deferred/i);
	assert.doesNotMatch(String(field.description), /FIFO|starv|agent_wait/);

	// The model sees the same terse union on the flat declaration's single property.
	const host = await createTestOwnerHost(t, piAgentCoordination);
	const declared = JSON.parse(JSON.stringify(host.session.getToolDefinition("agent_message")?.parameters));
	const declaredField = declared.properties.deliveryMode as { anyOf?: { const?: string }[]; description?: string };
	assert.deepEqual(declaredField.anyOf?.map(variant => variant.const), ["deferred", "steer", "background"]);
	assert.match(String(declaredField.description), /defaults to deferred/i);
	assert.doesNotMatch(String(declaredField.description), /FIFO|starv|agent_wait/);
});

test("all delivery modes and omission validate through TypeBox and native Pi tool validation", () => {
	const validator = Compile(parameters);
	for (const base of baseInputs) {
		for (const deliveryMode of [undefined, "deferred", "steer", "background"]) {
			const input = deliveryMode === undefined ? base : { ...base, deliveryMode };
			assert.equal(validator.Check(input), true, JSON.stringify(input));
			assert.deepEqual(validateToolArguments(tool, fauxToolCall(tool.name, input as unknown as JsonObject)), input);
		}
	}
});

test("closed operation-specific arguments reject foreign fields", () => {
	const invalid = [
		...baseInputs.flatMap(base => [{ ...base, deliveryMode: "invalid" }, { ...base, extra: true }]),
		{ operation: "answer", requestId: "request", answer: "Done", deliveryMode: "steer" },
		{ operation: "cancel", requestMessageId: "request", reason: "Withdrawn", deliveryMode: "background" },
		{ operation: "poll", messageId: "message", deliveryMode: "deferred" },
		{ operation: "retry", messageId: "message", deliveryMode: "deferred" },
	];
	// The exact contract rejects them; Pi's validation of the flat declaration is
	// looser, so tool execution enforces this (see participant-tool-registrar tests).
	for (const input of invalid) {
		assert.equal(Check(parameters, input), false, JSON.stringify(input));
	}
});

test("no registered tool declaration carries resolution keywords", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination);
	for (const name of Object.keys(coordinationToolSchemas)) {
		assert.deepEqual(resolutionKeywordsIn(coordinationToolSchemas[name as keyof typeof coordinationToolSchemas]), [], name);
		const declared = host.session.getToolDefinition(name)?.parameters;
		if (declared === undefined) continue; // not registered for the Owner
		const serialized = JSON.parse(JSON.stringify(declared));
		assert.deepEqual(resolutionKeywordsIn(serialized), [], name);
		// Transport and provider internals must not leak into the declaration.
		assert.deepEqual(nodes(serialized).flatMap(node => Object.keys(node).filter(key => key.startsWith("~"))), [], name);
		// OpenAI-compatible providers and DeepSeek validate the schema root before variants.
		assert.equal(serialized.type, "object", name);
	}
});

test("nested tool input validates inside control transport", () => {
	const request = agentControlProtocol.childToOwner.methods["coordination.message"].request;
	for (const schema of [request, JSON.parse(JSON.stringify(request))]) {
		const validator = Compile(schema);
		for (const base of baseInputs) {
			const value = { toolCallId: "call", input: { ...base, deliveryMode: "background" } };
			assert.equal(validator.Check(value), true);
			assert.equal(validator.Check({ ...value, input: { ...base, deliveryMode: "wrong-scope" } }), false);
		}
	}
});
