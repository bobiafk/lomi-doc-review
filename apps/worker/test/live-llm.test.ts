import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildExtractionPrompt, extractPdfText, validateExtraction } from "@lomi/extraction";
import { describe, expect, it } from "vitest";
import { AnthropicExtractionLlm } from "../src/anthropic-llm.js";
import { FIXTURES } from "./helpers.js";

/**
 * Optional smoke test against the real API (costs a few cents). Off by default;
 * run with LIVE_LLM=1 and ANTHROPIC_API_KEY set (or in the repo-root .env).
 */
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (process.env["LIVE_LLM"] === "1" && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

describe.runIf(process.env["LIVE_LLM"] === "1")("live LLM extraction", () => {
  it("extracts every invoice field with evidence that validates against the real text", { timeout: 180_000 }, async () => {
    const llm = new AnthropicExtractionLlm(
      process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-5-5",
      process.env["ANTHROPIC_API_KEY"] ?? "",
    );
    const text = await extractPdfText(new Uint8Array(await readFile(`${FIXTURES}documents/invoice-001.pdf`)));
    const result = await llm.extract(buildExtractionPrompt("invoice", text), new AbortController().signal);
    const fields = validateExtraction("invoice", text, result.output);

    expect(fields.filter((f) => f.gapReason !== null)).toEqual([]);
    const byField = Object.fromEntries(fields.map((f) => [f.field, f.value]));
    expect(byField).toEqual({
      invoice_number: "INV-2025-0847",
      issue_date: "2025-09-14",
      due_date: "2025-10-14",
      vendor_name: expect.stringMatching(/meridian office supplies/i),
      total_amount: { cents: 523029, currency: "USD" },
    });
  });
});
