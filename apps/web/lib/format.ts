import type { FieldType, FieldValue, GapReason, VersionStatus } from "@lomi/shared";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Human-readable value. Dates stay unambiguous; money shows its currency. */
export function formatValue(value: FieldValue | null, type: FieldType): string {
  if (value === null) return "—";
  if (typeof value === "object") {
    const amount = value.cents / 100;
    return value.currency
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(amount)
      : amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return dateFormat.format(new Date(`${value}T00:00:00Z`));
  }
  if (type === "percent" && typeof value === "number") return `${value}%`;
  return String(value);
}

/** What goes in the correction input to start from: the value in the format the API accepts. */
export function toInputValue(value: FieldValue | null): string {
  if (value === null) return "";
  if (typeof value === "object") return (value.cents / 100).toFixed(2);
  return String(value);
}

export const INPUT_HINT: Record<FieldType, string> = {
  string: "Text",
  date: "YYYY-MM-DD",
  money: "Amount, e.g. 5230.29",
  number: "Number, e.g. 24",
  percent: "Percent, e.g. 4.2",
};

export function humanizeField(field: string): string {
  const words = field.replaceAll("_", " ").replace(/\b1br\b/, "1-bedroom");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function humanizeType(type: string): string {
  return humanizeField(type);
}

export const GAP_LABEL: Record<GapReason, { title: string; explanation: string }> = {
  not_found: { title: "Not in document", explanation: "The model reports the document doesn't state this." },
  not_returned: { title: "Not returned", explanation: "The model's answer skipped this field." },
  invalid_value: { title: "Unreadable value", explanation: "The model's value couldn't be read as this field's type." },
  evidence_not_found: {
    title: "Quote not in document",
    explanation: "The model's quote doesn't appear in this version's text, so its value was discarded.",
  },
  value_not_in_evidence: {
    title: "Quote doesn't support value",
    explanation: "The quote is real but doesn't contain the value the model claimed, so it was discarded.",
  },
};

export const STATUS_LABEL: Record<VersionStatus, string> = {
  queued: "Queued",
  extracting: "Extracting",
  extracted: "Extracted",
  failed: "Failed",
  superseded: "Superseded",
};

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return dateFormat.format(new Date(iso));
}
