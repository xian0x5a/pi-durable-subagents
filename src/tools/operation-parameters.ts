import { isDeepStrictEqual } from "node:util";
import { Type, type TObject, type TSchema } from "typebox";
import { Value } from "typebox/value";

/*
 * Model-facing declarations for operation-discriminated tools.
 *
 * A tool such as agent_message keeps one closed object schema per operation, joined
 * in a union. That union stays the exact input contract: the control transport and
 * the execute check below validate against it. It cannot be the declaration the
 * model sees, because Gemini 3+ strict tool sampling (Pi sends functionCallingConfig
 * mode "VALIDATED") rejects any function whose top-level parameters schema is an
 * anyOf, with or without `type: "object"` beside it. Unions nested inside a property
 * are accepted.
 *
 * So the declaration is derived from the union: one closed object whose `operation`
 * enum lists every operation, whose description states each operation's fields, and
 * whose other properties are optional and say which operations require them.
 * Valid calls keep exactly the argument shape the union accepts, so committed
 * transcript records and their readers are unaffected.
 */

type OperationVariant = TObject & Readonly<{ description?: string }>;

type OperationForm = Readonly<{
	operation: string;
	variants: readonly OperationVariant[];
	required: readonly string[];
	optional: readonly string[];
	notes: readonly string[];
}>;

export type OperationToolDeclaration = Readonly<{
	parameters: TSchema;
	prepareArguments(args: unknown): unknown;
}>;

/**
 * For an operation union: the flat declaration the model sees, and the check of
 * the raw tool-call arguments against the union. Undefined for any other schema,
 * which the model sees as is.
 */
export function operationToolDeclaration(toolName: string, schema: TSchema): OperationToolDeclaration | undefined {
	const variants = operationVariants(schema);
	if (variants === undefined) return undefined;
	const forms = operationForms(variants);
	return {
		parameters: flatDeclaration(variants, forms),
		prepareArguments: (args) => checkOperationArguments(toolName, schema, forms, args),
	};
}

function flatDeclaration(variants: readonly OperationVariant[], forms: readonly OperationForm[]): TSchema {
	const fieldNames = [...new Set(variants.flatMap((variant) => Object.keys(variant.properties)))]
		.filter((name) => name !== "operation");
	// Plain JSON Schema: TypeBox's Type.Optional on a spread copy would add its
	// modifier as an enumerable key that the provider would then receive.
	return {
		type: "object",
		properties: {
			operation: {
				type: "string",
				enum: forms.map((form) => form.operation),
				description: `Each operation accepts only its own fields:\n${forms.map((form) => `- ${formUsage(form)}`).join("\n")}`,
			},
			...Object.fromEntries(fieldNames.map((name) => [name, mergedField(name, variants, forms)])),
		},
		required: ["operation"],
		additionalProperties: false,
	};
}

/**
 * Accept exactly the inputs the operation union accepts. The flat declaration
 * cannot state per-operation requirements, so this check fails fast with the
 * operation's field list and what the arguments got wrong.
 */
function checkOperationArguments(
	toolName: string,
	schema: TSchema,
	forms: readonly OperationForm[],
	value: unknown,
): unknown {
	if (Value.Check(schema, value)) return value;
	const operation = typeof value === "object" && value !== null ? (value as { operation?: unknown }).operation : undefined;
	const form = forms.find((candidate) => candidate.operation === operation);
	if (form === undefined) {
		throw new Error(
			`invalid_input: ${toolName} operation must be one of: ${forms.map((candidate) => candidate.operation).join(", ")}`,
		);
	}
	throw new Error(
		`invalid_input: ${toolName} operation ${formUsage(form)} Invalid arguments: ${closestErrors(form.variants, value)}`,
	);
}

function operationVariants(schema: TSchema): readonly OperationVariant[] | undefined {
	if (!Type.IsUnion(schema)) return undefined;
	const variants = schema.anyOf;
	const discriminated = variants.every((variant) =>
		Type.IsObject(variant) && typeof (variant.properties.operation as { const?: unknown } | undefined)?.const === "string"
	);
	return discriminated ? variants as readonly TSchema[] as readonly OperationVariant[] : undefined;
}

/** One form per operation; an operation may span several variants, e.g. search scopes. */
function operationForms(variants: readonly OperationVariant[]): readonly OperationForm[] {
	const operations = [...new Set(variants.map(operationOf))];
	return operations.map((operation) => {
		const own = variants.filter((variant) => operationOf(variant) === operation);
		const fields = [...new Set(own.flatMap((variant) => Object.keys(variant.properties)))]
			.filter((name) => name !== "operation");
		const required = fields.filter((name) => own.every((variant) => (variant.required ?? []).includes(name)));
		return {
			operation,
			variants: own,
			required,
			optional: fields.filter((name) => !required.includes(name)),
			notes: [...new Set(own.flatMap((variant) => variant.description ?? []))],
		};
	});
}

function operationOf(variant: OperationVariant): string {
	return (variant.properties.operation as unknown as { const: string }).const;
}

function fieldList(form: OperationForm): string {
	const parts = [
		...(form.required.length === 0 ? [] : [form.required.join(", ")]),
		...(form.optional.length === 0 ? [] : [`optional ${form.optional.join(", ")}`]),
	];
	return parts.length === 0 ? "no other fields" : parts.join("; ");
}

function formUsage(form: OperationForm): string {
	return `"${form.operation}": ${fieldList(form)}.${form.notes.map((note) => ` ${note}`).join("")}`;
}

/** A field shared by several operations keeps each distinct schema, as a nested union if they differ. */
function mergedField(name: string, variants: readonly OperationVariant[], forms: readonly OperationForm[]): TSchema {
	const schemas = variants.flatMap((variant) => variant.properties[name] ?? []);
	const distinct = schemas.filter((schema, index) =>
		schemas.findIndex((candidate) => isDeepStrictEqual(candidate, schema)) === index
	);
	const requiredBy = forms.filter((form) => form.required.includes(name)).map((form) => form.operation);
	const optionalFor = forms.filter((form) => form.optional.includes(name)).map((form) => form.operation);
	const usage = [
		...(requiredBy.length === 0 ? [] : [`Required for ${requiredBy.join(", ")}.`]),
		...(optionalFor.length === 0 ? [] : [`Optional for ${optionalFor.join(", ")}.`]),
	].join(" ");
	if (distinct.length > 1) return { anyOf: distinct, description: usage };
	const [only] = distinct as [TSchema & { description?: string }];
	return { ...only, description: only.description === undefined ? usage : `${usage} ${only.description}` };
}

/** Errors of the operation's variants that come nearest to the arguments; ties are all reported. */
function closestErrors(variants: readonly OperationVariant[], value: unknown): string {
	const described = variants.map((variant) => ({
		count: Value.Errors(variant, value).length,
		text: describeErrors(variant, value),
	}));
	const fewest = Math.min(...described.map(({ count }) => count));
	return [...new Set(described.filter(({ count }) => count === fewest).map(({ text }) => text))].join("; or ");
}

function describeErrors(schema: TSchema, value: unknown): string {
	const messages = Value.Errors(schema, value).map((error) => {
		const field = error.instancePath === "" ? "" : `${error.instancePath.slice(1).replaceAll("/", ".")} `;
		const additional = error.keyword === "additionalProperties"
			? ` (${(error.params as { additionalProperties: string[] }).additionalProperties.join(", ")})`
			: "";
		return `${field}${error.message}${additional}`;
	});
	return [...new Set(messages)].join(", ");
}
