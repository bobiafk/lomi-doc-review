import { describe, expect, it } from "vitest";
import { formatValue, humanizeField, toInputValue } from "./format";

describe("formatValue", () => {
  it("formats each field type for a reviewer", () => {
    expect(formatValue({ cents: 523029, currency: "USD" }, "money")).toBe("$5,230.29");
    expect(formatValue({ cents: 198500, currency: null }, "money")).toBe("1,985.00");
    expect(formatValue("2025-09-14", "date")).toBe("Sep 14, 2025");
    expect(formatValue(4.2, "percent")).toBe("4.2%");
    expect(formatValue(24, "number")).toBe("24");
    expect(formatValue("INV-2025-0847", "string")).toBe("INV-2025-0847");
    expect(formatValue(null, "string")).toBe("—");
  });

  it("does not shift dates across time zones", () => {
    expect(formatValue("2025-03-01", "date")).toBe("Mar 1, 2025");
  });
});

describe("toInputValue", () => {
  it("prefills corrections in the format the API accepts", () => {
    expect(toInputValue({ cents: 612645, currency: "USD" })).toBe("6126.45");
    expect(toInputValue("2025-11-13")).toBe("2025-11-13");
    expect(toInputValue(null)).toBe("");
  });
});

describe("humanizeField", () => {
  it("turns field names into labels", () => {
    expect(humanizeField("year_over_year_rent_growth")).toBe("Year over year rent growth");
    expect(humanizeField("average_rent_1br")).toBe("Average rent 1-bedroom");
  });
});
