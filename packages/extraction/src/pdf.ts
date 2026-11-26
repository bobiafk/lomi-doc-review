import { extractText, getDocumentProxy } from "unpdf";

export class PdfParseError extends Error {
  override readonly name = "PdfParseError";
}

/**
 * Extracts the PDF's text layer, pages joined by newlines. This exact string is
 * stored as the version's parsed_text and is what evidence is validated against.
 * A PDF without a text layer (a scan) is an error, not an empty document.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let text: string;
  try {
    // pdf.js may detach the buffer it is given; hand it a copy.
    const pdf = await getDocumentProxy(bytes.slice());
    ({ text } = await extractText(pdf, { mergePages: true }));
  } catch (error) {
    throw new PdfParseError(`could not parse PDF: ${(error as Error).message}`, { cause: error });
  }
  if (text.trim() === "") throw new PdfParseError("PDF has no text layer (scanned image?)");
  return text;
}
