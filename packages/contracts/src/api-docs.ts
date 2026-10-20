import { z } from "zod";
import { ERROR_CODES, ERROR_HTTP_STATUS, ErrorResponseSchema } from "./api-schemas";
import { ENDPOINTS, type EndpointDef, type InputDef } from "./endpoints";
import { TRANSITION_RULES } from "./state-machine";

// ---- JSON Schema -> field rows ----

type Json = { [key: string]: unknown };

interface Row {
  field: string;
  type: string;
  required: boolean;
  notes: string;
}

const asJson = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v.map(asJson) : []);

const isNull = (s: Json) => s.type === "null";

function constraints(s: Json): string[] {
  const out: string[] = [];
  const { minLength, maxLength, minItems, maxItems } = s as Record<string, number | undefined>;
  // Zod's .int() adds the safe-integer range as bounds; that is not a real limit for API users.
  const real = (n: unknown) => (typeof n === "number" && Math.abs(n) < Number.MAX_SAFE_INTEGER ? n : undefined);
  const minimum = real(s.minimum);
  const maximum = real(s.maximum);
  if (minLength !== undefined || maxLength !== undefined) {
    out.push(
      maxLength === undefined ? (minLength === 1 ? "non-empty" : `at least ${minLength} chars`) : `${minLength ?? 0}–${maxLength} chars`,
    );
  }
  if (minimum !== undefined && maximum !== undefined) out.push(`${minimum} to ${maximum}`);
  else if (minimum !== undefined) out.push(`at least ${minimum}`);
  else if (maximum !== undefined) out.push(`at most ${maximum}`);
  if (minItems !== undefined || maxItems !== undefined) {
    out.push(maxItems === undefined ? `at least ${minItems} item${minItems === 1 ? "" : "s"}` : `${minItems ?? 0}–${maxItems} items`);
  }
  if (typeof s.pattern === "string" && !s.format) out.push(`pattern \`${s.pattern}\``);
  if (s.default !== undefined) out.push(`default \`${JSON.stringify(s.default)}\``);
  return out;
}

function scalarType(s: Json): string {
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (Array.isArray(s.enum)) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" | ");
  const format = s.format as string | undefined;
  if (format === "uuid") return "string (uuid)";
  if (format === "date-time") return "string (ISO 8601 UTC)";
  if (format === "uri") return "string (URL)";
  if (s.type === "integer") return "integer";
  if (typeof s.type === "string") return s.type;
  return "any";
}

/** Splits `anyOf: [X, null]` into X and a nullable flag. */
function unwrapNullable(s: Json): { schema: Json; nullable: boolean } {
  const variants = asArray(s.anyOf);
  if (variants.length === 2 && variants.some(isNull)) {
    return {
      schema: { ...variants.find((v) => !isNull(v)), description: s.description ?? variants.find((v) => !isNull(v))?.description },
      nullable: true,
    };
  }
  return { schema: s, nullable: false };
}

function unionVariants(s: Json): Json[] | null {
  const variants = asArray(s.oneOf).length ? asArray(s.oneOf) : asArray(s.anyOf);
  return variants.length > 1 && variants.every((v) => v.type === "object") ? variants : null;
}

/** The property that tells union variants apart (a `const` or single-value enum in every variant). */
function discriminator(variants: Json[]): string | null {
  const first = asJson(variants[0].properties);
  for (const key of Object.keys(first)) {
    const values = variants.map((v) => {
      const p = asJson(asJson(v.properties)[key]);
      return p.const ?? (Array.isArray(p.enum) && p.enum.length === 1 ? p.enum[0] : undefined);
    });
    if (values.every((v) => v !== undefined)) return key;
  }
  return null;
}

function variantLabel(variant: Json, key: string): string {
  const p = asJson(asJson(variant.properties)[key]);
  return `${key}=${JSON.stringify(p.const ?? (p.enum as unknown[])[0])}`;
}

function typeLabel(s: Json): string {
  if (s.type === "array") {
    const items = asJson(s.items);
    const inner = unwrapNullable(items).schema;
    return inner.type === "object" || unionVariants(inner) ? "object[]" : `${scalarType(inner)}[]`;
  }
  if (s.type === "object") return "object";
  return scalarType(s);
}

function collectRows(schema: Json, path: string, required: boolean, rows: Row[]): void {
  const { schema: s, nullable } = unwrapNullable(schema);
  const description = typeof s.description === "string" ? s.description : "";
  const limits = constraints(s);
  const notes = [description, limits.length ? `(${limits.join(", ")})` : ""].filter(Boolean).join(" ");
  const variants = unionVariants(s);
  const label = variants ? "object (one of)" : typeLabel(s);

  if (path) rows.push({ field: path, type: nullable ? `${label} or null` : label, required, notes });

  if (variants) {
    const key = discriminator(variants);
    variants.forEach((variant, i) => {
      const marker = key ? `{${variantLabel(variant, key)}}` : `{variant ${i + 1}}`;
      collectObjectRows(variant, `${path}${marker}`, rows);
    });
    return;
  }
  if (s.type === "object") collectObjectRows(s, path, rows);
  if (s.type === "array") {
    const items = unwrapNullable(asJson(s.items)).schema;
    if (items.type === "object" && !unionVariants(items)) collectObjectRows(items, `${path}[]`, rows);
  }
}

function collectObjectRows(obj: Json, path: string, rows: Row[]): void {
  const props = asJson(obj.properties);
  const required = new Set(Array.isArray(obj.required) ? (obj.required as string[]) : []);
  for (const [name, child] of Object.entries(props)) {
    const childPath = path ? `${path}.${name}` : name;
    collectRows(asJson(child), childPath, required.has(name), rows);
  }
}

const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function table(rows: Row[]): string {
  if (!rows.length) return "_No fields._\n";
  const lines = ["| Field | Type | Required | Notes |", "| --- | --- | --- | --- |"];
  for (const r of rows) {
    lines.push(`| \`${r.field}\` | ${escapeCell(r.type)} | ${r.required ? "yes" : "no"} | ${escapeCell(r.notes)} |`);
  }
  return lines.join("\n") + "\n";
}

/** Field table for a schema; a top-level union gets one table per variant. */
function schemaTables(schema: z.ZodType, io: "input" | "output"): string {
  const json = asJson(z.toJSONSchema(schema, { io, unrepresentable: "any" }));
  const variants = unionVariants(json);
  if (variants) {
    const key = discriminator(variants);
    return variants
      .map((variant, i) => {
        const rows: Row[] = [];
        collectObjectRows(variant, "", rows);
        const title = key ? `When \`${variantLabel(variant, key)}\`` : `Variant ${i + 1}`;
        return `${title}:\n\n${table(rows)}`;
      })
      .join("\n");
  }
  const rows: Row[] = [];
  collectObjectRows(json, "", rows);
  return table(rows);
}

// ---- examples ----

/** Throws if any example in the registry does not parse against its own schema. */
export function assertExamplesValid(endpoints: readonly EndpointDef[] = ENDPOINTS): void {
  const check = (where: string, schema: z.ZodType, example: unknown) => {
    const result = schema.safeParse(example);
    if (!result.success) throw new Error(`Invalid example for ${where}: ${JSON.stringify(result.error.issues)}`);
  };
  for (const e of endpoints) {
    for (const [name, def] of [
      ["params", e.params],
      ["query", e.query],
      ["body", e.body],
    ] as const) {
      if (def) check(`${e.id} ${name}`, def.schema, def.example);
    }
    for (const r of e.responses) check(`${e.id} response ${r.status}`, r.schema, r.example);
  }
}

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```\n";

function exampleUrl(e: EndpointDef): string {
  let path = e.path;
  const params = (e.params?.example ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(params)) path = path.replace(`:${k}`, String(v));
  const query = Object.entries((e.query?.example ?? {}) as Record<string, unknown>);
  return query.length ? `${path}?${query.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : path;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};
const statusLine = (n: number) => `${n} ${STATUS_TEXT[n] ?? ""}`.trim();

function inputSection(title: string, def: InputDef, io: "input", withExample: "json" | "none"): string {
  const parts = [`**${title}**\n`, schemaTables(def.schema, io)];
  if (withExample === "json") parts.push(json(def.example));
  return parts.join("\n");
}

function endpointSection(e: EndpointDef): string {
  const out: string[] = [];
  out.push(`### ${e.summary}\n`);
  out.push(`\`${e.method} ${e.path}\`\n`);
  out.push(e.description + "\n");
  if (e.params || e.query) out.push(`Example request line: \`${e.method} ${exampleUrl(e)}\`\n`);
  if (e.params) out.push(inputSection("Path parameters", e.params, "input", "none"));
  if (e.query) out.push(inputSection("Query parameters", e.query, "input", "none"));
  if (e.body) out.push(inputSection("Request body", e.body, "input", "json"));
  for (const r of e.responses) {
    out.push(`**Response \`${statusLine(r.status)}\`**: ${r.description}\n`);
    out.push(schemaTables(r.schema, "output"));
    out.push(json(r.example));
  }
  const errors = [...e.errors, { status: 500, code: "internal_error" as const, when: "Unexpected server error." }];
  out.push("**Errors**\n");
  out.push(
    [
      "| Status | `error.code` | When |",
      "| --- | --- | --- |",
      ...errors.map((x) => `| ${x.status} | \`${x.code}\` | ${escapeCell(x.when)} |`),
    ].join("\n") + "\n",
  );
  return out.join("\n");
}

// ---- document ----

const validationErrorExample = ErrorResponseSchema.parse({
  error: {
    code: "validation_error",
    message: "Request body is invalid",
    details: [{ code: "too_small", path: ["acceptanceCriteria"], message: "Too small: expected array to have >=1 items" }],
  },
});

const notFoundExample = ErrorResponseSchema.parse({
  error: { code: "not_found", message: "Initiative 3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34 not found" },
});

function conventions(): string {
  return [
    "## Conventions",
    "",
    "- All paths are relative to the server origin. Requests and responses are JSON (`Content-Type: application/json`).",
    "- There is no authentication yet. `reviewer` fields are free-form identifiers.",
    "- Ids of initiatives, artifacts, questions, approvals and runs are UUIDs. Repo ids are lowercase slugs.",
    "- Inside one initiative, items are referenced by readable ids: acceptance criteria `AC-1`, requirements `FR-1` / `NFR-1`, design sections `DS-1`, tasks `T-1`.",
    "- Timestamps are ISO 8601 in UTC (`2026-10-21T09:30:00.000Z`).",
    "- Agents run in the background. Calls that start an agent return immediately with a `*_GENERATING` status (or a repo status of `profiling` / `indexing`); poll the resource until it settles. In mock mode (`LLM_MODE=mock`) this takes milliseconds.",
    "- A request that would move an initiative to a status the state machine does not allow is rejected with `409 invalid_transition` and changes nothing.",
    "",
    "### Errors",
    "",
    "Every error has the same shape:",
    "",
    json(notFoundExample).trimEnd(),
    "",
    "| Status | `error.code` | Meaning |",
    "| --- | --- | --- |",
    ...ERROR_CODES.map((c) => {
      const meaning: Record<(typeof ERROR_CODES)[number], string> = {
        validation_error: "The request does not match the schema. `error.details` lists the Zod issues.",
        not_found: "The initiative, repo or artifact does not exist.",
        invalid_transition: "The initiative is in a status where this action is not allowed.",
        conflict: "The request conflicts with current state (for example a duplicate repo or an already-answered question).",
        internal_error: "Unexpected server error.",
      };
      return `| ${ERROR_HTTP_STATUS[c]} | \`${c}\` | ${meaning[c]} |`;
    }),
    "",
    "A validation error carries the Zod issues:",
    "",
    json(validationErrorExample).trimEnd(),
    "",
  ].join("\n");
}

function statusModel(): string {
  const rows = TRANSITION_RULES.map((r) => `| \`${r.from}\` | \`${r.to}\` | ${r.actors.join(", ")} | ${escapeCell(r.description)} |`);
  return [
    "## Status model",
    "",
    "Every change of `Initiative.status` goes through the state machine in `@sdd/contracts`. Agents never change status: they propose, the orchestrator transitions, humans approve. These are all the legal transitions and who may trigger them:",
    "",
    "| From | To | Triggered by | Meaning |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "Statuses ending in `_GENERATING` are transient: an agent is running. Poll `GET /api/initiatives/:id` until the status changes.",
    "",
  ].join("\n");
}

/** Renders docs/API.md. Pure and deterministic: the same registry always gives the same text. */
export function renderApiDocs(endpoints: readonly EndpointDef[] = ENDPOINTS): string {
  assertExamplesValid(endpoints);
  const tags = [...new Set(endpoints.map((e) => e.tag))];

  const index = ["| Endpoint | Summary |", "| --- | --- |", ...endpoints.map((e) => `| \`${e.method} ${e.path}\` | ${e.summary} |`)].join(
    "\n",
  );

  const sections = tags.map((tag) => [`## ${tag}`, "", ...endpoints.filter((e) => e.tag === tag).map(endpointSection)].join("\n"));

  return (
    [
      "# REST API",
      "",
      "<!-- GENERATED FILE. Do not edit by hand: change the schemas or endpoint definitions in packages/contracts, then run `pnpm docs:api`. CI fails if this file is out of date. -->",
      "",
      "This document is generated from the Zod schemas and endpoint definitions in `@sdd/contracts` (`packages/contracts/src/endpoints.ts`). Every example below is parsed against its schema when this file is generated, so an example cannot drift from the API.",
      "",
      "Building against it: the endpoint registry (`API` / `ENDPOINTS`) is exported from `@sdd/contracts` with the schemas and examples, so the server can validate with the same schemas and the UI mock API can serve the same example responses.",
      "",
      "## Endpoints",
      "",
      index,
      "",
      conventions(),
      statusModel(),
      ...sections,
    ].join("\n") + "\n"
  );
}
