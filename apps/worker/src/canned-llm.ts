import type { ExtractionPrompt } from "@lomi/extraction";
import type { ExtractionLlm, LlmResult } from "./llm.js";

/**
 * DEV ONLY: answers like a well-behaved model, but only for the fixture
 * documents, without calling any API. Selected with EXTRACTION_LLM=canned to
 * develop the UI or demo the pipeline without an API key; the run log records
 * model "canned-dev", so its output is never mistaken for a real extraction.
 * Everything after the LLM call (evidence validation, carry-over, fenced
 * commit) is the real pipeline.
 */
export class CannedLlm implements ExtractionLlm {
  readonly model = "canned-dev";

  /** `delayMs` simulates a slow model, so chaos tests can act mid-extraction. */
  constructor(private readonly delayMs = 0) {}

  async extract(prompt: ExtractionPrompt, signal?: AbortSignal): Promise<LlmResult> {
    if (this.delayMs > 0) await sleep(this.delayMs, signal);
    const output = cannedOutputFor(prompt.user);
    return { model: this.model, output, raw: { canned: true, output }, inputTokens: null, outputTokens: null };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const found = (value: string, evidence: string, currency: string | null = null) => ({
  found: true,
  value,
  currency,
  evidence,
  reason: null,
});
const notFound = (reason: string) => ({ found: false, value: null, currency: null, evidence: null, reason });

export const cannedOutputs = {
  invoiceV1: {
    fields: {
      invoice_number: found("INV-2025-0847", "Invoice Number: INV-2025-0847"),
      issue_date: found("2025-09-14", "Issue Date: 2025-09-14"),
      due_date: found("2025-10-14", "Due Date: 2025-10-14"),
      vendor_name: found("Meridian Office Supplies LLC", "MERIDIAN OFFICE SUPPLIES LLC"),
      total_amount: found("5230.29", "Total Due: $5,230.29", "USD"),
    },
  },
  invoiceV2: {
    fields: {
      invoice_number: found("INV-2025-0847", "Invoice Number: INV-2025-0847"),
      issue_date: found("2025-09-14", "Issue Date: 2025-09-14"),
      due_date: found("2025-11-13", "Due Date: 2025-11-13"),
      vendor_name: found("Meridian Office Supplies LLC", "MERIDIAN OFFICE SUPPLIES LLC"),
      total_amount: found("6126.45", "Total Due: $6,126.45", "USD"),
    },
  },
  lease: {
    fields: {
      tenant_name: found("Dana Okafor", 'Dana Okafor ("Tenant")'),
      monthly_rent: found("2350.00", "monthly rent of $2,350.00", "USD"),
      security_deposit: found("3525.00", "the sum of $3,525.00 as a security deposit", "USD"),
      lease_start: found("2025-03-01", "commencing on March 1, 2025"),
      term_months: found("24", "twenty-four (24) months"),
    },
  },
  marketReport: {
    fields: {
      report_quarter: found("Q3 2025", "Reporting Period: Q3 2025"),
      market_area: found("Eastport-Harborview Submarket", "Market Area: Eastport-Harborview Submarket"),
      vacancy_rate: found("4.2", "The overall vacancy rate declined to 4.2%"),
      average_rent_1br: found("1985", "one-bedroom unit reached $1,985 per month", "USD"),
      year_over_year_rent_growth: found("3.8", "a year-over-year increase of 3.8%"),
      median_household_income: notFound("The excerpt does not mention household income."),
    },
  },
};

function cannedOutputFor(user: string): unknown {
  if (user.includes("Invoice Number: INV-2025-0847")) {
    return user.includes("INVOICE (REVISED)") ? cannedOutputs.invoiceV2 : cannedOutputs.invoiceV1;
  }
  if (user.includes("RESIDENTIAL LEASE AGREEMENT")) return cannedOutputs.lease;
  if (user.includes("EASTPORT RENTAL MARKET REPORT")) return cannedOutputs.marketReport;
  // Unknown document: every field becomes a not_found gap, never a guess.
  const fields = /Fields to extract: (.*)/.exec(user)?.[1] ?? "";
  return {
    fields: Object.fromEntries(
      fields
        .split(", ")
        .map((f) => f.replace(/ \(.*\)$/, ""))
        .filter(Boolean)
        .map((f) => [f, notFound("canned-dev LLM only knows the fixture documents")]),
    ),
  };
}
