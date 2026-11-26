import { describe, expect, it } from "vitest";
import { normalizeValue, valuesEqual, valueSupportedByEvidence } from "../src/values.js";

function ok(result: ReturnType<typeof normalizeValue>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("normalizeValue", () => {
  it("string: collapses whitespace, rejects empty", () => {
    expect(ok(normalizeValue("string", "  Dana \n Okafor "))).toBe("Dana Okafor");
    expect(normalizeValue("string", "   ").ok).toBe(false);
  });

  it("date: accepts real ISO calendar dates only", () => {
    expect(ok(normalizeValue("date", "2025-09-14"))).toBe("2025-09-14");
    expect(normalizeValue("date", "2025-02-30").ok).toBe(false);
    expect(normalizeValue("date", "September 14, 2025").ok).toBe(false);
    expect(normalizeValue("date", "2025-9-14").ok).toBe(false);
  });

  it("money: integer cents plus currency", () => {
    expect(ok(normalizeValue("money", "5230.29", "usd"))).toEqual({ cents: 523029, currency: "USD" });
    expect(ok(normalizeValue("money", "$5,230.29"))).toEqual({ cents: 523029, currency: "USD" });
    expect(ok(normalizeValue("money", 1985))).toEqual({ cents: 198500, currency: null });
    expect(ok(normalizeValue("money", "0.1"))).toEqual({ cents: 10, currency: null });
    expect(normalizeValue("money", "1.005").ok).toBe(false);
    expect(normalizeValue("money", "about 5k").ok).toBe(false);
    expect(normalizeValue("money", "12", "dollars").ok).toBe(false);
  });

  it("percent: a number of percentage points", () => {
    expect(ok(normalizeValue("percent", "4.2%"))).toBe(4.2);
    expect(ok(normalizeValue("percent", 3.8))).toBe(3.8);
    expect(normalizeValue("percent", "four").ok).toBe(false);
  });

  it("number: finite numbers only", () => {
    expect(ok(normalizeValue("number", "24"))).toBe(24);
    expect(ok(normalizeValue("number", "1,200"))).toBe(1200);
    expect(normalizeValue("number", "twenty-four").ok).toBe(false);
    expect(normalizeValue("number", Number.NaN).ok).toBe(false);
  });
});

describe("valuesEqual", () => {
  it("compares normalized values structurally", () => {
    expect(valuesEqual({ cents: 523029, currency: "USD" }, { cents: 523029, currency: "USD" })).toBe(true);
    expect(valuesEqual({ cents: 523029, currency: "USD" }, { cents: 612645, currency: "USD" })).toBe(false);
    expect(valuesEqual({ cents: 523029, currency: "USD" }, { cents: 523029, currency: null })).toBe(false);
    expect(valuesEqual("2025-10-14", "2025-11-13")).toBe(false);
    expect(valuesEqual(4.2, 4.2)).toBe(true);
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual("24", 24)).toBe(false);
  });
});

describe("valueSupportedByEvidence", () => {
  it("money: the amount appears in the quote", () => {
    const total = { cents: 523029, currency: "USD" };
    expect(valueSupportedByEvidence("money", total, "Total Due: $5,230.29")).toBe(true);
    expect(valueSupportedByEvidence("money", { cents: 481500, currency: "USD" }, "Total Due: $5,230.29")).toBe(
      false,
    );
    expect(valueSupportedByEvidence("money", { cents: 198500, currency: "USD" }, "reached $1,985 per month")).toBe(
      true,
    );
  });

  it("percent and number: the number appears in the quote", () => {
    expect(valueSupportedByEvidence("percent", 4.2, "vacancy rate declined to 4.2%, down from 4.9%")).toBe(true);
    expect(valueSupportedByEvidence("percent", 3.9, "vacancy rate declined to 4.2%")).toBe(false);
    expect(valueSupportedByEvidence("number", 24, "twenty-four (24) months")).toBe(true);
  });

  it("date: ISO or a common written form of the same date appears in the quote", () => {
    expect(valueSupportedByEvidence("date", "2025-09-14", "Issue Date: 2025-09-14")).toBe(true);
    expect(valueSupportedByEvidence("date", "2025-03-01", "commencing on March 1, 2025 and ending")).toBe(true);
    expect(valueSupportedByEvidence("date", "2025-03-01", "commencing on 1 March 2025")).toBe(true);
    expect(valueSupportedByEvidence("date", "2025-03-01", "ending on February 28, 2027")).toBe(false);
  });

  it("string: the value appears in the quote, ignoring case and whitespace", () => {
    expect(valueSupportedByEvidence("string", "Meridian Office Supplies LLC", "MERIDIAN OFFICE SUPPLIES LLC")).toBe(
      true,
    );
    expect(valueSupportedByEvidence("string", "Dana Okafor", "Residential LP and Dana\nOkafor")).toBe(true);
    expect(valueSupportedByEvidence("string", "Harborview Residential LP", "and Dana Okafor")).toBe(false);
  });
});
