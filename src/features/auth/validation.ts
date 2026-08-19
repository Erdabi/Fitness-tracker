import { z } from 'zod';

/**
 * Credential validation.
 *
 * Runs before any network call so obvious mistakes get an instant, specific
 * message instead of a round trip and a generic server error.
 */

/** Minimum length matches the Supabase project default. Raise both together. */
export const MIN_PASSWORD_LENGTH = 8;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .email('That does not look like an email address');

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  // Supabase rejects passwords over 72 bytes (bcrypt's limit) with an opaque
  // error, so catch it here where the message can be useful.
  .max(72, 'Use 72 characters or fewer');

export const signInSchema = z.object({
  email: emailSchema,
  // Sign-in only checks presence: an existing password may predate a rule
  // change, and telling someone their correct password is "too short" is wrong.
  password: z.string().min(1, 'Enter your password'),
});

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
});

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Password strength, for the sign-up meter.
 *
 * Deliberately advisory: length is the dominant factor in real-world strength,
 * so composition rules only nudge the score rather than blocking submission.
 */
export type PasswordStrength = 'weak' | 'fair' | 'strong';

export function scorePassword(password: string): PasswordStrength {
  if (password.length < MIN_PASSWORD_LENGTH) return 'weak';

  // A long passphrase is strong on length alone. `correcthorsebatterystaple`
  // carries far more entropy than `Ab1!xyzq`, and a rule that demanded mixed
  // case would rate it lower — which is exactly the advice that pushes people
  // toward short, hard-to-remember passwords.
  if (password.length >= 20) return 'strong';

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;

  if (password.length >= 14 && variety >= 2) return 'strong';
  if (password.length >= 12 || variety >= 3) return 'fair';
  return 'weak';
}
