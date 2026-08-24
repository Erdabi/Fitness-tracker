import Anthropic from 'npm:@anthropic-ai/sdk@0.71.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.71.0/helpers/zod';
import type { z } from 'npm:zod@3.25.76';

import { MAX_OUTPUT_TOKENS, PROVIDER_TIMEOUT_MS } from './limits.ts';

/**
 * The Claude boundary.
 *
 * One place constructs the client, so the API key is read from the
 * environment in exactly one file and cannot drift into a handler. The key
 * exists only in the function's environment — it is never sent to the app, and
 * the app has no code path that could use it if it were.
 */

export const MODEL = 'claude-opus-5';

let client: Anthropic | null = null;

export function claude(): Anthropic {
  if (client) return client;

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured for this function.');
  }

  client = new Anthropic({ apiKey, timeout: PROVIDER_TIMEOUT_MS, maxRetries: 1 });
  return client;
}

export interface VisionRequest<T extends z.ZodTypeAny> {
  readonly system: string;
  readonly instruction: string;
  readonly image: { data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' };
  readonly schema: T;
}

export interface VisionResult<T> {
  readonly value: T;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * One structured vision call.
 *
 * `messages.parse` with `output_config.format` constrains the response to the
 * schema and validates it — the application never sees free-form prose, and a
 * response that does not fit the contract arrives as a parse failure rather
 * than as text something downstream has to guess at.
 *
 * Adaptive thinking is on: reading a nutrition panel involves resolving units,
 * matching columns to headers and deciding what is genuinely illegible, and
 * the cost of a misread digit here is a wrong food stored forever.
 */
export async function analyzeImage<T extends z.ZodTypeAny>(
  request: VisionRequest<T>,
): Promise<VisionResult<z.infer<T>>> {
  const response = await claude().messages.parse({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: 'adaptive' },
    system: request.system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: request.image.mediaType,
              data: request.image.data,
            },
          },
          { type: 'text', text: request.instruction },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(request.schema) },
  });

  /*
   * `parsed_output` is null when the model's output did not satisfy the
   * schema. Treated as a hard failure: a partially-parsed nutrition label is
   * worse than none, because the missing half looks like absent data rather
   * than a failed read.
   */
  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw Object.assign(new Error('Model output did not match the schema.'), {
      name: 'SchemaMismatch',
    });
  }

  return {
    value: response.parsed_output as z.infer<T>,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
