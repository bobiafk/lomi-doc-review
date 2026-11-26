import { readFile } from "node:fs/promises";
import { buildExtractionPrompt, extractPdfText, validateExtraction } from "@lomi/extraction";
import { describe, expect, it } from "vitest";
import { CannedLlm } from "../src/canned-llm.js";
import { FIXTURES } from "./helpers.js";

const signal = new AbortController().signal;

async function extract(type: "invoice" | "lease" | "market_report", file: string) {
  const text = await extractPdfText(new Uint8Array(await readFile(`${FIXTURES}documents/${file}`)));
  const result = await new CannedLlm().extract(buildExtractionPrompt(type, text), signal);
  return validateExtraction(type, text, result.output);
}

describe("CannedLlm (dev-only stand-in)", () => {
  it.each([
    ["invoice", "invoice-001.pdf", 0],
    ["invoice", "invoice-001.v2.pdf", 0],
    ["lease", "lease-excerpt-001.pdf", 0],
    ["market_report", "market-report-excerpt-001.pdf", 1],
  ] as const)("its %s answer for %s passes the real evidence validation", async (type, file, gaps) => {
    const fields = await extract(type, file);
    expect(fields.filter((f) => f.gapReason !== null)).toHaveLength(gaps);
  });

  it("answers an unknown document with not_found gaps, never a guess", async () => {
    const result = await new CannedLlm().extract(buildExtractionPrompt("invoice", "some other invoice"), signal);
    const fields = validateExtraction("invoice", "some other invoice", result.output);
    expect(fields.every((f) => f.gapReason === "not_found")).toBe(true);
  });
});

describe("CannedLlm delay", () => {
  it("can be aborted mid-delay, like a real request", async () => {
    const controller = new AbortController();
    const pending = new CannedLlm(10_000).extract(buildExtractionPrompt("invoice", "x"), controller.signal);
    controller.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow("lease lost");
  });
});
