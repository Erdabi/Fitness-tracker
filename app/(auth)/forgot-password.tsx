import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Screen, Text, TextField } from '@/components/ui';
import { requestPasswordReset } from '@/features/auth/authService';
import { resetPasswordSchema } from '@/features/auth/validation';
import { useTheme } from '@/theme';

export default function ForgotPasswordScreen() {
  const theme = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(): Promise<void> {
    setFormError(null);

    const parsed = resetPasswordSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);

    setSubmitting(true);
    const result = await requestPasswordReset(parsed.data);
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.md }}>
          <Text variant="title">Check your inbox</Text>
          {/*
            Worded so it reads the same whether or not an account exists —
            confirming which addresses are registered would leak them.
          */}
          <Text variant="body" color="secondary">
            If {email} has an account, we have sent a link to reset the password.
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
        <Text variant="displayMedium">Reset your password</Text>
        <Text variant="body" color="secondary">
          We will email you a link to set a new one.
        </Text>
      </View>

      <View style={{ gap: theme.spacing.lg }}>
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          error={fieldError}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
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
          label="Send reset link"
          loading={submitting}
          onPress={() => {
            void handleSubmit();
          }}
        />

        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
