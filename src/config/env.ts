import Constants from 'expo-constants';
import { z } from 'zod';

/**
 * Validated public configuration.
 *
 * Reads from `app.config.cjs` -> `extra`, which is populated from EXPO_PUBLIC_*
 * variables at build time. Validation happens once at module load so a missing
 * or malformed value fails immediately with an actionable message, rather than
 * surfacing later as an opaque network error against `undefined/auth/v1/token`.
 */

const EnvSchema = z.object({
  supabaseUrl: z
    .string({ required_error: 'EXPO_PUBLIC_SUPABASE_URL is not set' })
    .url('EXPO_PUBLIC_SUPABASE_URL must be a full URL, e.g. https://abc.supabase.co'),
  supabaseAnonKey: z
    .string({ required_error: 'EXPO_PUBLIC_SUPABASE_ANON_KEY is not set' })
    .min(20, 'EXPO_PUBLIC_SUPABASE_ANON_KEY looks truncated'),
  appEnv: z.enum(['development', 'preview', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Exported for testing. Production code should use the `env` singleton so the
 * validation cost is paid once.
 */
export function parseEnv(raw: unknown): Env {
  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  • ${issue.message}`)
      .join('\n');

    throw new Error(
      `Configuration is invalid:\n${problems}\n\n` +
        'Copy .env.example to .env.local and fill in the values from your ' +
        'Supabase project (Project Settings → API), then restart the dev server ' +
        'so the new values are picked up.',
    );
  }

  return result.data;
}

export const env: Env = parseEnv(Constants.expoConfig?.extra ?? {});

export const isProduction = env.appEnv === 'production';
