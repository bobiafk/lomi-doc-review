import type { LlmFieldResult } from "../src/response.js";

type Fields = Record<string, LlmFieldResult>;

export const found = (value: string, evidence: string, currency: string | null = null): LlmFieldResult => ({
  found: true,
  value,
  currency,
  evidence,
  reason: null,
});

export const notFound = (reason: string): LlmFieldResult => ({
  found: false,
  value: null,
  currency: null,
  evidence: null,
  reason,
});

/** What a well-behaved model returns for invoice v1. */
export function invoiceV1Response(overrides: Fields = {}): { fields: Fields } {
  return {
    fields: {
      invoice_number: found("INV-2025-0847", "Invoice Number: INV-2025-0847"),
      issue_date: found("2025-09-14", "Issue Date: 2025-09-14"),
      due_date: found("2025-10-14", "Due Date: 2025-10-14"),
      vendor_name: found("Meridian Office Supplies LLC", "MERIDIAN OFFICE SUPPLIES LLC"),
      total_amount: found("5230.29", "Total Due: $5,230.29", "USD"),
      ...overrides,
    },
  };
}

/** What a well-behaved model returns for invoice v2 (revised due date and total). */
export function invoiceV2Response(overrides: Fields = {}): { fields: Fields } {
  return invoiceV1Response({
    due_date: found("2025-11-13", "Due Date: 2025-11-13"),
    total_amount: found("6126.45", "Total Due: $6,126.45", "USD"),
    ...overrides,
  });
}
