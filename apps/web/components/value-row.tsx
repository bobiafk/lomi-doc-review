"use client";

import type { ReviewRequest, ValueDto } from "@lomi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, queryKeys } from "../lib/api";
import { formatValue, GAP_LABEL, humanizeField, INPUT_HINT, toInputValue } from "../lib/format";
import { ReviewTag } from "./tags";

interface Props {
  value: ValueDto;
  documentId: string;
  /** False for historical versions: shown, never reviewable. */
  editable: boolean;
  focused: boolean;
  onFocus: () => void;
}

/**
 * One extracted value beside its source quote. The extracted value never
 * changes; a correction is shown as the effective value with the extracted one
 * struck through next to it.
 */
export function ValueRow({ value, documentId, editable, focused, onFocus }: Props) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");

  const review = useMutation({
    mutationFn: (body: ReviewRequest) => api.review(value.id, body),
    onSuccess: async () => {
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["document", documentId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.documents }),
      ]);
    },
  });

  function startCorrecting() {
    setInput(toInputValue(value.effectiveValue));
    setNote("");
    setEditing(true);
    review.reset();
  }

  function submitCorrection(event: FormEvent) {
    event.preventDefault();
    const body: ReviewRequest = { action: "correct", value: input };
    if (value.fieldType === "money" && value.effectiveValue && typeof value.effectiveValue === "object" && value.effectiveValue.currency) {
      body.currency = value.effectiveValue.currency;
    }
    if (note.trim()) body.note = note.trim();
    review.mutate(body);
  }

  const corrected = value.review?.action === "correct";
  const previousChanged = value.previous && value.reviewState === "pending";

  return (
    <div className={`value-row ${focused ? "focused" : ""}`} onMouseEnter={onFocus} onClick={onFocus}>
      <div className="value-field">{humanizeField(value.field)}</div>

      <div className="value-main">
        <div className={`value-value ${value.effectiveValue === null ? "gap" : ""}`}>
          {value.effectiveValue === null ? "No value" : formatValue(value.effectiveValue, value.fieldType)}
          {corrected && (
            <span className="value-extracted">
              extracted <s>{formatValue(value.extractedValue, value.fieldType)}</s>
            </span>
          )}
        </div>

        {value.evidence && <blockquote className="quote">{value.evidence.text}</blockquote>}

        {value.gap && (
          <>
            <div className="gap-reason">
              <strong>{GAP_LABEL[value.gap.reason].title}.</strong> {value.gap.detail ?? GAP_LABEL[value.gap.reason].explanation}
            </div>
            {value.gap.unverifiedQuote && (
              <blockquote className="quote unverified" title="This quote was not found verbatim in the document">
                {value.gap.unverifiedQuote}
              </blockquote>
            )}
          </>
        )}

        {value.review?.note && <div className="note">“{value.review.note}”</div>}
        {value.review?.carriedFrom && (
          <div className="note">
            {value.review.action === "correct" ? "Correction" : "Approval"} carried over from v{value.review.carriedFrom.versionNo}: the
            value and its quote are unchanged.
          </div>
        )}

        {previousChanged && value.previous && (
          <div className="previous">
            <span className="label">Was in v{value.previous.versionNo}:</span>
            <span className="old">
              {value.previous.value === null ? "no value" : formatValue(value.previous.value, value.fieldType)}
            </span>
            {value.previous.review ? (
              <span>
                {value.previous.review.action === "correct"
                  ? `corrected to ${formatValue(value.previous.review.correctedValue, value.fieldType)}`
                  : "approved"}
                {value.previous.review.note && <span className="muted"> · “{value.previous.review.note}”</span>}
              </span>
            ) : (
              <span className="muted">not reviewed</span>
            )}
          </div>
        )}
      </div>

      <div className="value-side">
        <ReviewTag state={value.reviewState} gap={value.gap?.reason ?? null} />
        {editable && !editing && (
          <div className="value-actions">
            {value.reviewState !== "approved" && (
              <button
                className="btn small"
                disabled={review.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  review.mutate({ action: "approve" });
                }}
                title={
                  value.gap
                    ? "Confirm the value is not in the document"
                    : corrected
                      ? "Drop the correction and approve the extracted value"
                      : "The value matches the quote"
                }
              >
                ✓ {value.gap ? "Confirm gap" : corrected ? "Use extracted" : "Approve"}
              </button>
            )}
            <button className="btn small" onClick={(e) => (e.stopPropagation(), startCorrecting())}>
              ✎ {value.gap ? "Add value" : "Correct"}
            </button>
          </div>
        )}
      </div>

      {editing && (
        <form className="editor" onSubmit={submitCorrection} onClick={(e) => e.stopPropagation()}>
          <div className="editor-row">
            <input
              className="input"
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={INPUT_HINT[value.fieldType]}
              aria-label={`Corrected ${humanizeField(value.field)}`}
            />
            <button className="btn primary small" type="submit" disabled={!input.trim() || review.isPending}>
              Save correction
            </button>
            <button className="btn ghost small" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): why is it different?" />
        </form>
      )}
      {review.error && <div className="error-text" style={{ gridColumn: "2 / 4" }}>{review.error.message}</div>}
    </div>
  );
}
