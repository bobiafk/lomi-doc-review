import type { ValueDto } from "@lomi/shared";
import { useEffect, useRef } from "react";
import { formatValue, humanizeField } from "../lib/format";

/**
 * The version's parsed text with the focused value's evidence highlighted.
 * The text is the source document and never changes; the header shows the
 * focused value as it currently stands (including a correction).
 */
export function DocumentText({ text, value, versionNo }: { text: string; value: ValueDto | null; versionNo: number }) {
  const markRef = useRef<HTMLElement>(null);
  const highlight = value?.evidence ?? null;
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlight?.start, highlight?.end]);

  const valid = highlight && highlight.start >= 0 && highlight.end <= text.length && highlight.start < highlight.end;
  const corrected = value?.review?.action === "correct";
  return (
    <aside className="doc-text" aria-label="Document text">
      <div className="doc-text-header">
        <span>Document text · v{versionNo}</span>
        <span>{valid ? "quote highlighted" : value ? "no quote for this value" : "hover a value"}</span>
      </div>
      {value && (
        <div className="doc-text-focus">
          <span className="faint">{humanizeField(value.field)}</span>{" "}
          <strong>{formatValue(value.effectiveValue, value.fieldType)}</strong>
          {corrected && (
            <span className="faint">
              {" "}
              · corrected; the document says {formatValue(value.extractedValue, value.fieldType)}
            </span>
          )}
        </div>
      )}
      <pre>
        {valid ? (
          <>
            {text.slice(0, highlight.start)}
            <mark ref={markRef}>{text.slice(highlight.start, highlight.end)}</mark>
            {text.slice(highlight.end)}
          </>
        ) : (
          text
        )}
      </pre>
    </aside>
  );
}
