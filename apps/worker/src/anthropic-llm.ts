import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionPrompt } from "@lomi/extraction";
import { LlmError, type ExtractionLlm, type LlmResult } from "./llm.js";

/**
 * Extraction via the Messages API with structured outputs: the response is
 * JSON constrained by the prompt's schema (Claude Sonnet 5.5 rejects forced
 * tool use, and JSON output is all we need). Server-side refusal fallback is
 * on, so a policy decline is retried on a fallback model inside the same call;
 * the model that answered is recorded on the run.
 */
export class AnthropicExtractionLlm implements ExtractionLlm {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    // The SDK already retries 408/409/429/5xx twice with backoff.
    this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  }

  async extract(prompt: ExtractionPrompt, signal: AbortSignal): Promise<LlmResult> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          output_config: {
            // A one-page document and a fixed schema: medium is plenty.
            effort: "medium",
            format: { type: "json_schema", schema: { ...prompt.schema } },
          },
        },
        { signal },
      );
    } catch (error) {
      throw toLlmError(error);
    }

    if (message.stop_reason === "refusal") {
      throw new LlmError(`model declined the request (${message.stop_details?.category ?? "no category"})`, false, message);
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmError("response was cut off at max_tokens", false, message);
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new LlmError("response is not valid JSON", false, message);
    }

    return {
      model: message.model,
      output,
      raw: message,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}

function toLlmError(error: unknown): unknown {
  // An abort is ours (lease lost); let the caller recognise it as such.
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return new LlmError(`transient LLM error: ${error.message}`, true, null, { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError(`LLM request failed (${error.status ?? "no status"}): ${error.message}`, false, null, {
      cause: error,
    });
  }
  return error;
}
