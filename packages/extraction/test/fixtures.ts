import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractPdfText } from "../src/pdf.js";

const cache = new Map<string, Promise<string>>();

/** Parsed text of a real fixture PDF, via the same parser the worker uses. */
export function fixtureText(file: string): Promise<string> {
  let text = cache.get(file);
  if (!text) {
    const path = fileURLToPath(new URL(`../../../fixtures/documents/${file}`, import.meta.url));
    text = readFile(path).then((bytes) => extractPdfText(new Uint8Array(bytes)));
    cache.set(file, text);
  }
  return text;
}
