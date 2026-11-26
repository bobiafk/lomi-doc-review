import type { FieldType, FieldValue, MoneyValue } from "@lomi/shared";
import { normalizeForMatch } from "./text.js";

/**
 * Value normalization is deterministic and strict: the model is asked for
 * canonical forms (ISO dates, plain decimals) and anything else is rejected
 * rather than guessed at. Normalized values are what carry-over compares.
 */

export type NormalizeResult = { ok: true; value: FieldValue } | { ok: false; error: string };

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const MONEY_DECIMAL = /^-?(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

export function normalizeValue(type: FieldType, raw: string | number, currency?: string | null): NormalizeResult {
  if (typeof raw === "number" && !Number.isFinite(raw)) return fail("not a finite number");
  const text = typeof raw === "number" ? String(raw) : normalizeForMatch(raw);

  switch (type) {
    case "string":
      return text === "" ? fail("empty string") : { ok: true, value: text };
    case "date":
      return isIsoDate(text) ? { ok: true, value: text } : fail(`expected a calendar date as YYYY-MM-DD, got "${text}"`);
    case "money":
      return normalizeMoney(text, currency);
    case "percent":
    case "number": {
      const withoutSign = type === "percent" && text.endsWith("%") ? text.slice(0, -1) : text;
      const plain = withoutSign.replaceAll(",", "").trim();
      return DECIMAL.test(plain) ? { ok: true, value: Number(plain) } : fail(`expected a number, got "${text}"`);
    }
  }
}

function normalizeMoney(text: string, currency: string | null | undefined): NormalizeResult {
  let code: string | null = null;
  if (currency != null && currency !== "") {
    if (!/^[A-Za-z]{3}$/.test(currency)) return fail(`expected an ISO 4217 currency code, got "${currency}"`);
    code = currency.toUpperCase();
  }
  let amount = text;
  const symbol = amount[0];
  if (symbol !== undefined && symbol in CURRENCY_SYMBOLS) {
    code ??= CURRENCY_SYMBOLS[symbol]!;
    amount = amount.slice(1);
  }
  amount = amount.replaceAll(",", "").trim();
  const match = MONEY_DECIMAL.exec(amount);
  if (!match) return fail(`expected an amount with at most 2 decimals, got "${text}"`);
  const negative = amount.startsWith("-");
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  const value: MoneyValue = { cents: negative ? -cents : cents, currency: code };
  return { ok: true, value };
}

function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function fail(error: string): NormalizeResult {
  return { ok: false, error };
}

export function valuesEqual(a: FieldValue | null, b: FieldValue | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "object" && typeof b === "object") return a.cents === b.cents && a.currency === b.currency;
  return a === b;
}

/**
 * Second line of hallucination defense: the quote must not only exist in the
 * document, it must actually state the value. Catches a model that quotes the
 * right line but reports a different number.
 */
export function valueSupportedByEvidence(type: FieldType, value: FieldValue, quote: string): boolean {
  const normalizedQuote = normalizeForMatch(quote);
  switch (type) {
    case "string":
      return typeof value === "string" && normalizedQuote.toLowerCase().includes(value.toLowerCase());
    case "date":
      return typeof value === "string" && dateRenderings(value).some((r) => normalizedQuote.toLowerCase().includes(r));
    case "money":
      return (
        typeof value === "object" && numbersIn(normalizedQuote).some((n) => Math.round(n * 100) === value.cents)
      );
    case "percent":
    case "number":
      return typeof value === "number" && numbersIn(normalizedQuote).includes(value);
  }
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replaceAll(",", "")),
  );
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Lower-cased ways a document commonly writes an ISO date. */
function dateRenderings(iso: string): string[] {
  const [y, m, d] = iso.split("-");
  const month = MONTHS[Number(m) - 1]!;
  const short = month.slice(0, 3);
  const day = String(Number(d));
  return [
    iso,
    `${month} ${day}, ${y}`,
    `${month} ${d}, ${y}`,
    `${short} ${day}, ${y}`,
    `${short}. ${day}, ${y}`,
    `${day} ${month} ${y}`,
    `${day} ${short} ${y}`,
    `${m}/${d}/${y}`,
    `${Number(m)}/${day}/${y}`,
  ];
}
