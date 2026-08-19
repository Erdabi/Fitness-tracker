import React from 'react';
import { View } from 'react-native';

import { ErrorState } from './ui/states';
import { logger } from '@/lib/logger';

interface Props {
  children: React.ReactNode;
  /** Rendered instead of the default error screen. */
  fallback?: (reset: () => void) => React.ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-time crashes so a broken subtree does not blank the app.
 *
 * Class component because React exposes no hook equivalent of
 * `componentDidCatch`.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error): void {
    // Message and stack only — never component props, which on this screen
    // could contain health data.
    logger.error('Render error caught by boundary', {
      name: error.name,
      message: error.message,
    });
  }

  private readonly reset = (): void => {
    this.setState({ hasError: false });
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(this.reset);
    }

    return (
      <View style={{ flex: 1 }}>
        <ErrorState
          title="This screen ran into a problem"
          description="The rest of the app is fine. Try loading this screen again."
          onRetry={this.reset}
        />
      </View>
    );
  }
}
