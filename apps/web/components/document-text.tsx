import { useEffect, useRef } from "react";

/** The version's parsed text with the focused value's evidence highlighted. */
export function DocumentText({
  text,
  highlight,
  versionNo,
}: {
  text: string;
  highlight: { start: number; end: number } | null;
  versionNo: number;
}) {
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlight?.start, highlight?.end]);

  const valid = highlight && highlight.start >= 0 && highlight.end <= text.length && highlight.start < highlight.end;
  return (
    <aside className="doc-text" aria-label="Document text">
      <div className="doc-text-header">
        <span>Document text · v{versionNo}</span>
        <span>{valid ? "quote highlighted" : "hover a value"}</span>
      </div>
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
