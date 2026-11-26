import type { DocumentSummary, Progress, ValueDto } from "@lomi/shared";
import { describe, expect, it } from "vitest";
import { attentionSummary, groupValues, listRefetchInterval, POLL_MS } from "./review";

function value(field: string, overrides: Partial<ValueDto> = {}): ValueDto {
  return {
    id: field,
    field,
    fieldType: "string",
    extractedValue: "x",
    effectiveValue: "x",
    evidence: { text: "x", start: 0, end: 1 },
    gap: null,
    reviewState: "pending",
    review: null,
    previous: null,
    ...overrides,
  };
}

const gap = { reason: "not_found" as const, detail: null, unverifiedQuote: null };
const previous = { valueId: "p", versionNo: 1, value: "y", gap: null, review: null };

describe("groupValues", () => {
  it("puts what needs attention first: changed values, then pending, then gaps", () => {
    const groups = groupValues([
      value("a_gap", { gap, extractedValue: null, effectiveValue: null, evidence: null }),
      value("b_pending"),
      value("c_carried", { reviewState: "carried_over", previous }),
      value("d_changed", { previous }),
      value("e_approved", { reviewState: "approved" }),
      value("f_corrected", { reviewState: "corrected" }),
    ]);
    expect(groups.attention.map((v) => v.field)).toEqual(["d_changed", "b_pending", "a_gap"]);
    expect(groups.carriedOver.map((v) => v.field)).toEqual(["c_carried"]);
    expect(groups.reviewed.map((v) => v.field)).toEqual(["e_approved", "f_corrected"]);
  });
});

describe("listRefetchInterval", () => {
  const doc = (status: DocumentSummary["status"]) => ({ status }) as DocumentSummary;

  it("polls only while something is queued or extracting", () => {
    expect(listRefetchInterval([doc("extracted"), doc("queued")])).toBe(POLL_MS);
    expect(listRefetchInterval([doc("extracted"), doc("extracting")])).toBe(POLL_MS);
    expect(listRefetchInterval([doc("extracted"), doc("failed"), doc("superseded")])).toBe(false);
    expect(listRefetchInterval(undefined)).toBe(false);
  });
});

describe("attentionSummary", () => {
  const progress = (p: Partial<Progress>): Progress => ({
    total: 5, pending: 0, gaps: 0, approved: 0, corrected: 0, carriedOver: 0, ...p,
  });

  it("says in one line what needs the reviewer", () => {
    expect(attentionSummary(progress({ pending: 2, carriedOver: 3 }), "extracted")).toBe("2 of 5 need review · 3 carried over");
    expect(attentionSummary(progress({ pending: 4, gaps: 1 }), "extracted")).toBe("5 of 5 need review · 1 gap");
    expect(attentionSummary(progress({ approved: 5 }), "extracted")).toBe("All 5 values reviewed");
    expect(attentionSummary(progress({}), "failed")).toBe("Extraction failed");
  });
});
