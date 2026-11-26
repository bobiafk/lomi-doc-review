import { z } from "zod";

export const FIELD_TYPES = ["string", "date", "money", "number", "percent"] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldDefinitionSchema = z.object({
  field: z.string().min(1),
  type: FieldTypeSchema,
});
export type FieldDefinition = z.infer<typeof FieldDefinitionSchema>;

/**
 * Fields to extract per document type. Mirrors fixtures/expected-fields.json;
 * a test fails if the two drift apart. Kept as a literal so DocumentType is a
 * closed union the compiler can check.
 */
export const FIELD_DEFINITIONS = {
  invoice: [
    { field: "invoice_number", type: "string" },
    { field: "issue_date", type: "date" },
    { field: "due_date", type: "date" },
    { field: "vendor_name", type: "string" },
    { field: "total_amount", type: "money" },
  ],
  lease: [
    { field: "tenant_name", type: "string" },
    { field: "monthly_rent", type: "money" },
    { field: "security_deposit", type: "money" },
    { field: "lease_start", type: "date" },
    { field: "term_months", type: "number" },
  ],
  market_report: [
    { field: "report_quarter", type: "string" },
    { field: "market_area", type: "string" },
    { field: "vacancy_rate", type: "percent" },
    { field: "average_rent_1br", type: "money" },
    { field: "year_over_year_rent_growth", type: "percent" },
    { field: "median_household_income", type: "money" },
  ],
} as const satisfies Record<string, readonly FieldDefinition[]>;

export type DocumentType = keyof typeof FIELD_DEFINITIONS;
export const DOCUMENT_TYPES = Object.keys(FIELD_DEFINITIONS) as [DocumentType, ...DocumentType[]];
export const DocumentTypeSchema = z.enum(DOCUMENT_TYPES);

export function fieldsFor(type: DocumentType): readonly FieldDefinition[] {
  return FIELD_DEFINITIONS[type];
}
