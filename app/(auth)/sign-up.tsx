import { Link, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Screen, Text, TextField } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  MIN_PASSWORD_LENGTH,
  scorePassword,
  signUpSchema,
} from '@/features/auth/validation';
import { useTheme } from '@/theme';

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const theme = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const strength = useMemo(() => (password ? scorePassword(password) : null), [password]);

  async function handleSubmit(): Promise<void> {
    setFormError(null);

    const parsed = signUpSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(collectFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    const result = await signUp(parsed.data);
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }

    if (result.value.needsEmailConfirmation) {
      // No session was issued. Saying so explicitly prevents the "nothing
      // happened" reading of a successful sign-up.
      setConfirmationSent(true);
      return;
    }

    router.replace('/(tabs)');
  }

  if (confirmationSent) {
    return (
      <Screen>
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            gap: theme.spacing.md,
          }}
        >
          <Text variant="title">Check your inbox</Text>
          <Text variant="body" color="secondary">
            We sent a confirmation link to {email}. Open it to finish setting up your
            account, then come back and sign in.
          </Text>
          <Button
            label="Back to sign in"
            variant="secondary"
            onPress={() => router.replace('/(auth)/sign-in')}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing['3xl'] }}>
        <Text variant="displayMedium">Create your account</Text>
        <Text variant="body" color="secondary">
          Your food, water and training log, synced across your devices.
        </Text>
      </View>

      <View style={{ gap: theme.spacing.lg }}>
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          error={fieldErrors.email}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!submitting}
        />

        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          error={fieldErrors.password}
          hint={
            strength
              ? `Strength: ${strength}`
              : `At least ${MIN_PASSWORD_LENGTH} characters`
          }
          secureToggle
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          editable={!submitting}
          onSubmitEditing={() => {
            void handleSubmit();
          }}
        />

        {formError ? (
          <Text variant="callout" color="danger" accessibilityLiveRegion="polite">
            {formError}
          </Text>
        ) : null}

        <Button
          label="Create account"
          loading={submitting}
          onPress={() => {
            void handleSubmit();
          }}
        />
      </View>

      <View style={{ flex: 1 }} />

      <Link href="/(auth)/sign-in" asChild>
        <Text variant="callout" color="accent" align="center">
          Already have an account? Sign in
        </Text>
      </Link>
    </Screen>
  );
}

function collectFieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}
