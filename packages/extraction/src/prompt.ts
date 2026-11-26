import { fieldsFor, type DocumentType, type FieldType } from "@lomi/shared";

/**
 * Builds the extraction request as plain data (no SDK types), so the worker
 * owns the LLM client and this package stays pure. The output is
 * deterministic: the stored prompt reproduces the call exactly.
 */

export const EXTRACTION_TOOL_NAME = "record_extracted_fields";

const VALUE_FORMAT: Record<FieldType, string> = {
  string: "the value as written in the document",
  date: "ISO date YYYY-MM-DD",
  money: 'plain decimal amount without symbols or thousands separators, e.g. "5230.29"',
  number: 'plain decimal number, digits only, e.g. "24"',
  percent: 'percentage points as a plain number without the % sign, e.g. "4.2" for 4.2%',
};

interface JsonSchema {
  type: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface FieldEntrySchema extends JsonSchema {
  properties: Record<string, JsonSchema>;
  required: string[];
}

export interface ExtractionTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: {
      fields: {
        type: "object";
        properties: Record<string, FieldEntrySchema>;
        required: string[];
        additionalProperties: false;
      };
    };
    required: ["fields"];
    additionalProperties: false;
  };
}

export interface ExtractionPrompt {
  system: string;
  user: string;
  tool: ExtractionTool;
}

const SYSTEM = `You extract structured fields from business documents for a human reviewer.

Rules:
- Use only the document text you are given. Never infer, compute or guess a value.
- For every field, "evidence" must be copied VERBATIM from the document text: an exact, contiguous passage (usually the line or clause that states the value). Do not paraphrase, reorder, fix typos or change capitalization. Keep it short, but long enough to contain the value.
- The evidence must contain the value as the document writes it.
- If the document does not state a field, set "found" to false, "value", "evidence" and "currency" to null, and explain briefly in "reason".
- Format values exactly as each field's description asks.
- Call the ${EXTRACTION_TOOL_NAME} tool exactly once.`;

function fieldEntrySchema(type: FieldType): FieldEntrySchema {
  const properties: Record<string, JsonSchema> = {
    found: { type: "boolean", description: "true if the document states this field" },
    value: { type: ["string", "null"], description: `${VALUE_FORMAT[type]}; null when not found` },
    evidence: {
      type: ["string", "null"],
      description: "verbatim passage from the document that states the value; null when not found",
    },
    reason: { type: ["string", "null"], description: "why the field was not found; null when found" },
  };
  const required = ["found", "value", "evidence", "reason"];
  if (type === "money") {
    properties["currency"] = {
      type: ["string", "null"],
      description: "ISO 4217 code (e.g. USD) if the document indicates it; otherwise null",
    };
    required.push("currency");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function buildExtractionPrompt(type: DocumentType, parsedText: string): ExtractionPrompt {
  const fields = fieldsFor(type);
  const properties = Object.fromEntries(fields.map((f) => [f.field, fieldEntrySchema(f.type)]));

  return {
    system: SYSTEM,
    user: [
      `Document type: ${type}`,
      `Fields to extract: ${fields.map((f) => `${f.field} (${f.type})`).join(", ")}`,
      "",
      "<document>",
      parsedText,
      "</document>",
    ].join("\n"),
    tool: {
      name: EXTRACTION_TOOL_NAME,
      description: `Record every ${type} field with its verbatim evidence, or why it is absent.`,
      input_schema: {
        type: "object",
        properties: {
          fields: {
            type: "object",
            properties,
            required: fields.map((f) => f.field),
            additionalProperties: false,
          },
        },
        required: ["fields"],
        additionalProperties: false,
      },
    },
  };
}
