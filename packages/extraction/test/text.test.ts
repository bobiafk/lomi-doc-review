import { describe, expect, it } from "vitest";
import { locateEvidence, normalizeForMatch } from "../src/text.js";
import { fixtureText } from "./fixtures.js";

function sliceOf(text: string, quote: string): string | null {
  const span = locateEvidence(text, quote);
  return span ? text.slice(span.start, span.end) : null;
}

describe("normalizeForMatch", () => {
  it("collapses every kind of whitespace run to one space and trims", () => {
    expect(normalizeForMatch("  Total\tDue:\n\n  $5,230.29  ")).toBe("Total Due: $5,230.29");
  });

  it("folds compatibility characters such as ligatures (NFKC)", () => {
    expect(normalizeForMatch("ofﬁce")).toBe("office");
  });

  it("keeps case and punctuation: matching stays verbatim", () => {
    expect(normalizeForMatch("INV-2025-0847")).toBe("INV-2025-0847");
  });
});

describe("locateEvidence", () => {
  const text = "Invoice Number: INV-2025-0847\nIssue Date:   2025-09-14\nDue Date: 2025-10-14";

  it("finds a quote and returns offsets into the original text", () => {
    expect(sliceOf(text, "Issue Date: 2025-09-14")).toBe("Issue Date:   2025-09-14");
  });

  it("matches across line breaks the quote does not have", () => {
    const wrapped = "a security deposit of\n$3,525.00 upon execution";
    expect(sliceOf(wrapped, "deposit of $3,525.00")).toBe("deposit of\n$3,525.00");
  });

  it("matches when the quote has line breaks the text does not", () => {
    expect(sliceOf(text, "Invoice Number:\n INV-2025-0847")).toBe("Invoice Number: INV-2025-0847");
  });

  it("ignores leading/trailing whitespace in the quote", () => {
    expect(sliceOf(text, "  Due Date: 2025-10-14\n")).toBe("Due Date: 2025-10-14");
  });

  it("maps offsets correctly after ligature expansion", () => {
    expect(sliceOf("The ﬁrst payment is due", "first payment")).toBe("ﬁrst payment");
  });

  it("rejects a hallucinated quote", () => {
    expect(locateEvidence(text, "Invoice Number: INV-2025-0848")).toBeNull();
    expect(locateEvidence(text, "Total Due: $5,230.29")).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(locateEvidence(text, "invoice number: INV-2025-0847")).toBeNull();
  });

  it("rejects empty or whitespace-only quotes", () => {
    expect(locateEvidence(text, "")).toBeNull();
    expect(locateEvidence(text, " \n ")).toBeNull();
  });

  it("does not treat missing whitespace as a match", () => {
    expect(locateEvidence("Net 30", "Net30")).toBeNull();
  });

  it("works on real fixture text, across the PDF's line wrap", async () => {
    const report = await fixtureText("market-report-excerpt-001.pdf");
    expect(
      sliceOf(report, "The overall vacancy rate declined to 4.2%, down from 4.9% in the prior quarter"),
    ).toBe("The overall vacancy rate declined to 4.2%, down from\n4.9% in the prior quarter");
  });
});
