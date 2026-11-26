import { describe, expect, it } from "vitest";
import { extractPdfText, PdfParseError } from "../src/pdf.js";
import { fixtureText } from "./fixtures.js";

describe("extractPdfText", () => {
  it("extracts the text layer of a fixture PDF", async () => {
    const text = await fixtureText("invoice-001.pdf");
    expect(text).toContain("Invoice Number: INV-2025-0847");
    expect(text).toContain("Total Due: $5,230.29");
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(extractPdfText(new TextEncoder().encode("not a pdf"))).rejects.toBeInstanceOf(
      PdfParseError,
    );
  });
});
