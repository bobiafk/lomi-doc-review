import type { ExtractionPrompt } from "@lomi/extraction";

/**
 * The worker's only dependency on an LLM. Tests inject a fake; production
 * uses AnthropicExtractionLlm. Implementations must honour `signal` so a
 * worker that loses its lease stops paying for a result it can't commit.
 */
export interface ExtractionLlm {
  /** Model requested; stored on the run row before the call starts. */
  readonly model: string;
  extract(prompt: ExtractionPrompt, signal: AbortSignal): Promise<LlmResult>;
}

export interface LlmResult {
  /** Model that actually answered (may differ after a server-side fallback). */
  model: string;
  /** Parsed JSON the model produced; validated by @lomi/extraction. */
  output: unknown;
  /** Full API response, stored verbatim on the run for debugging. */
  raw: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * A failed LLM call. `retryable` errors (rate limit, overload, network) are
 * retried automatically with backoff while attempts remain; anything else
 * (refusal, truncation, bad request) fails the version for a human to retry.
 */
export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly raw: unknown = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
