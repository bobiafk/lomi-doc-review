import { describe, expect, it } from "vitest";
import { planCarryOver, type CarryOverDecision, type PreviousValue } from "../src/carry-over.js";
import { validateExtraction, type ExtractedField } from "../src/validate.js";
import { fixtureText } from "./fixtures.js";
import { found, invoiceV1Response, invoiceV2Response, notFound } from "./responses.js";

/** v1 as stored: every value has an id and (unless told otherwise) a latest review. */
function asPrevious(fields: ExtractedField[], unreviewed: string[] = []): PreviousValue[] {
  return fields.map((f) => ({
    id: `value-${f.field}`,
    field: f.field,
    value: f.value,
    evidenceText: f.evidenceText,
    gapReason: f.gapReason,
    latestReviewId: unreviewed.includes(f.field) ? null : `review-${f.field}`,
  }));
}

function byField(decisions: CarryOverDecision[]): Record<string, CarryOverDecision> {
  return Object.fromEntries(decisions.map((d) => [d.field, d]));
}

async function invoiceV1(unreviewed: string[] = []): Promise<PreviousValue[]> {
  const text = await fixtureText("invoice-001.pdf");
  return asPrevious(validateExtraction("invoice", text, invoiceV1Response()), unreviewed);
}

describe("planCarryOver with the real invoice v1 -> v2", () => {
  it("leaves exactly due_date and total_amount pending; carries the other three", async () => {
    const v2Text = await fixtureText("invoice-001.v2.pdf");
    const current = validateExtraction("invoice", v2Text, invoiceV2Response());
    const decisions = byField(planCarryOver({ previous: await invoiceV1(), current, currentParsedText: v2Text }));

    const carried = Object.values(decisions).filter((d) => d.carryReviewId !== null).map((d) => d.field);
    const pending = Object.values(decisions).filter((d) => d.carryReviewId === null).map((d) => d.field);
    expect(carried.sort()).toEqual(["invoice_number", "issue_date", "vendor_name"]);
    expect(pending.sort()).toEqual(["due_date", "total_amount"]);

    expect(decisions["invoice_number"]).toEqual({
      field: "invoice_number",
      previousValueId: "value-invoice_number",
      carryReviewId: "review-invoice_number",
      reason: "unchanged",
    });
    expect(decisions["due_date"]).toEqual({
      field: "due_date",
      previousValueId: "value-due_date",
      carryReviewId: null,
      reason: "value_changed",
    });
    expect(decisions["total_amount"]?.reason).toBe("value_changed");
  });

  it("holds when the whole document's text shifts and reflows", async () => {
    const v2Text = await fixtureText("invoice-001.v2.pdf");
    const reflowed = `REVISION NOTICE\n\n\n${v2Text.replaceAll("\n", "  \n   ").replaceAll(": ", ":\n")}`;
    const current = validateExtraction("invoice", reflowed, invoiceV2Response());
    expect(current.every((f) => f.gapReason === null)).toBe(true);

    const decisions = planCarryOver({ previous: await invoiceV1(), current, currentParsedText: reflowed });
    expect(decisions.filter((d) => d.carryReviewId).map((d) => d.field).sort()).toEqual([
      "invoice_number",
      "issue_date",
      "vendor_name",
    ]);
  });

  it("does not carry when the value is equal but the old evidence is gone", async () => {
    const v2Text = (await fixtureText("invoice-001.v2.pdf")).replace(
      "Issue Date: 2025-09-14",
      "Date of issue: 2025-09-14",
    );
    const current = validateExtraction(
      "invoice",
      v2Text,
      invoiceV2Response({ issue_date: found("2025-09-14", "Date of issue: 2025-09-14") }),
    );
    const decisions = byField(planCarryOver({ previous: await invoiceV1(), current, currentParsedText: v2Text }));
    expect(decisions["issue_date"]).toMatchObject({ carryReviewId: null, reason: "evidence_changed" });
  });

  it("has nothing to carry for a value that was never reviewed, but still links the previous value", async () => {
    const v2Text = await fixtureText("invoice-001.v2.pdf");
    const current = validateExtraction("invoice", v2Text, invoiceV2Response());
    const decisions = byField(
      planCarryOver({ previous: await invoiceV1(["vendor_name"]), current, currentParsedText: v2Text }),
    );
    expect(decisions["vendor_name"]).toEqual({
      field: "vendor_name",
      previousValueId: "value-vendor_name",
      carryReviewId: null,
      reason: "not_reviewed",
    });
  });

  it("never carries a review onto or from a gap", async () => {
    const v1Text = await fixtureText("invoice-001.pdf");
    const v2Text = await fixtureText("invoice-001.v2.pdf");
    const previous = asPrevious(
      validateExtraction("invoice", v1Text, invoiceV1Response({ due_date: notFound("not stated") })),
    );
    const current = validateExtraction(
      "invoice",
      v2Text,
      invoiceV2Response({ invoice_number: notFound("not stated") }),
    );
    const decisions = byField(planCarryOver({ previous, current, currentParsedText: v2Text }));
    expect(decisions["due_date"]).toMatchObject({ carryReviewId: null, reason: "previous_was_gap" });
    expect(decisions["invoice_number"]).toMatchObject({ carryReviewId: null, reason: "now_a_gap" });
  });

  it("marks fields with no previous value as new", async () => {
    const v2Text = await fixtureText("invoice-001.v2.pdf");
    const current = validateExtraction("invoice", v2Text, invoiceV2Response());
    const previous = (await invoiceV1()).filter((p) => p.field !== "issue_date");
    const decisions = byField(planCarryOver({ previous, current, currentParsedText: v2Text }));
    expect(decisions["issue_date"]).toEqual({
      field: "issue_date",
      previousValueId: null,
      carryReviewId: null,
      reason: "no_previous_value",
    });
  });
});
