import { describe, expect, it } from "vitest";
import { ExtractionResponseError } from "../src/response.js";
import { validateExtraction, type ExtractedField } from "../src/validate.js";
import { fixtureText } from "./fixtures.js";
import { found, invoiceV1Response, notFound } from "./responses.js";

function byField(fields: ExtractedField[]): Record<string, ExtractedField> {
  return Object.fromEntries(fields.map((f) => [f.field, f]));
}

describe("validateExtraction on the real invoice v1 text", () => {
  it("keeps every value whose quote is in the text, with offsets into that text", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const fields = validateExtraction("invoice", text, invoiceV1Response());

    expect(fields.map((f) => f.field)).toEqual([
      "invoice_number",
      "issue_date",
      "due_date",
      "vendor_name",
      "total_amount",
    ]);
    for (const f of fields) {
      expect(f.gapReason, f.field).toBeNull();
      expect(text.slice(f.evidenceStart!, f.evidenceEnd!)).toBe(f.evidenceText);
    }
    const v = byField(fields);
    expect(v["total_amount"]?.value).toEqual({ cents: 523029, currency: "USD" });
    expect(v["issue_date"]?.value).toBe("2025-09-14");
    expect(v["vendor_name"]?.value).toBe("Meridian Office Supplies LLC");
  });

  it("turns a hallucinated quote into an evidence_not_found gap (value dropped, quote kept for debugging)", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const fields = byField(
      validateExtraction(
        "invoice",
        text,
        invoiceV1Response({ total_amount: found("5320.29", "Total Due: $5,320.29", "USD") }),
      ),
    );
    expect(fields["total_amount"]).toEqual({
      field: "total_amount",
      value: null,
      evidenceText: "Total Due: $5,320.29",
      evidenceStart: null,
      evidenceEnd: null,
      gapReason: "evidence_not_found",
      gapDetail: null,
    });
  });

  it("rejects a real quote that does not contain the claimed value", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const fields = byField(
      validateExtraction(
        "invoice",
        text,
        invoiceV1Response({ total_amount: found("4815.00", "Total Due: $5,230.29", "USD") }),
      ),
    );
    expect(fields["total_amount"]?.value).toBeNull();
    expect(fields["total_amount"]?.gapReason).toBe("value_not_in_evidence");
    expect(fields["total_amount"]?.evidenceStart).toBeNull();
  });

  it("records a field the model could not find as a not_found gap with its reason", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const fields = byField(
      validateExtraction("invoice", text, invoiceV1Response({ due_date: notFound("No due date is stated.") })),
    );
    expect(fields["due_date"]).toMatchObject({
      value: null,
      gapReason: "not_found",
      gapDetail: "No due date is stated.",
    });
  });

  it("treats found-without-evidence as evidence_not_found", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const fields = byField(
      validateExtraction("invoice", text, {
        fields: { ...invoiceV1Response().fields, due_date: { ...found("2025-10-14", ""), evidence: null } },
      }),
    );
    expect(fields["due_date"]?.gapReason).toBe("evidence_not_found");
  });

  it("records an unparseable value as an invalid_value gap", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const fields = byField(
      validateExtraction(
        "invoice",
        text,
        invoiceV1Response({ issue_date: found("Sept 14 2025", "Issue Date: 2025-09-14") }),
      ),
    );
    expect(fields["issue_date"]?.gapReason).toBe("invalid_value");
    expect(fields["issue_date"]?.gapDetail).toMatch(/YYYY-MM-DD/);
  });

  it("records a field the model omitted as not_returned and ignores unknown fields", async () => {
    const text = await fixtureText("invoice-001.pdf");
    const { vendor_name: _omitted, ...rest } = invoiceV1Response().fields;
    const fields = validateExtraction("invoice", text, {
      fields: { ...rest, po_number: found("PO-1", "Invoice Number") },
    });
    expect(fields).toHaveLength(5);
    expect(byField(fields)["vendor_name"]?.gapReason).toBe("not_returned");
    expect(byField(fields)["po_number"]).toBeUndefined();
  });

  it("throws on a response that does not have the tool's shape", async () => {
    const text = await fixtureText("invoice-001.pdf");
    expect(() => validateExtraction("invoice", text, "INV-2025-0847")).toThrow(ExtractionResponseError);
    expect(() => validateExtraction("invoice", text, { fields: [] })).toThrow(ExtractionResponseError);
    expect(() =>
      validateExtraction("invoice", text, { fields: { invoice_number: { found: "yes" } } }),
    ).toThrow(ExtractionResponseError);
  });
});

describe("validateExtraction on other real fixtures", () => {
  it("lease: dates and numbers written in words still need the value in the quote", async () => {
    const text = await fixtureText("lease-excerpt-001.pdf");
    const fields = byField(
      validateExtraction("lease", text, {
        fields: {
          tenant_name: found("Dana Okafor", 'Dana Okafor ("Tenant")'),
          monthly_rent: found("2350.00", "monthly rent of $2,350.00", "USD"),
          security_deposit: found("3525.00", "the sum of $3,525.00 as a security deposit", "USD"),
          lease_start: found("2025-03-01", "commencing on March 1, 2025"),
          term_months: found("24", "twenty-four (24) months"),
        },
      }),
    );
    for (const f of Object.values(fields)) expect(f.gapReason, f.field).toBeNull();
    expect(fields["term_months"]?.value).toBe(24);
    expect(fields["term_months"]?.evidenceText).toBe("twenty-four (24)\nmonths");
  });

  it("market report: a missing figure is a gap, the rest are kept", async () => {
    const text = await fixtureText("market-report-excerpt-001.pdf");
    const fields = byField(
      validateExtraction("market_report", text, {
        fields: {
          report_quarter: found("Q3 2025", "Reporting Period: Q3 2025"),
          market_area: found("Eastport-Harborview Submarket", "Market Area: Eastport-Harborview Submarket"),
          vacancy_rate: found("4.2", "The overall vacancy rate declined to 4.2%"),
          average_rent_1br: found("1985", "one-bedroom unit reached $1,985 per month", "USD"),
          year_over_year_rent_growth: found("3.8", "a year-over-year increase of 3.8%"),
          median_household_income: notFound("The excerpt does not mention household income."),
        },
      }),
    );
    expect(fields["vacancy_rate"]?.value).toBe(4.2);
    expect(fields["average_rent_1br"]?.value).toEqual({ cents: 198500, currency: "USD" });
    expect(fields["median_household_income"]?.gapReason).toBe("not_found");
  });
});
