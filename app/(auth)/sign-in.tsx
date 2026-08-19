import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Screen, Text, TextField } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { signInSchema } from '@/features/auth/validation';
import { useTheme } from '@/theme';

export default function SignInScreen() {
  const { signIn } = useAuth();
  const theme = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(): Promise<void> {
    setFormError(null);

    const parsed = signInSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(collectFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    const result = await signIn(parsed.data);
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    // The auth listener flips status to signedIn, which the guard picks up.
    router.replace('/(tabs)');
  }

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing['3xl'] }}>
        <Text variant="displayMedium">Welcome back</Text>
        <Text variant="body" color="secondary">
          Sign in to pick up where you left off.
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
          returnKeyType="next"
          editable={!submitting}
        />

        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          error={fieldErrors.password}
          secureToggle
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
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
          label="Sign in"
          loading={submitting}
          onPress={() => {
            void handleSubmit();
          }}
        />

        <Link href="/(auth)/forgot-password" asChild>
          <Text variant="callout" color="accent" align="center">
            Forgot your password?
          </Text>
        </Link>
      </View>

      <View style={{ flex: 1 }} />

      <Link href="/(auth)/sign-up" asChild>
        <Text variant="callout" color="accent" align="center">
          New here? Create an account
        </Text>
      </Link>
    </Screen>
  );
}

/** Flattens Zod issues into a field-keyed map for the inputs. */
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
