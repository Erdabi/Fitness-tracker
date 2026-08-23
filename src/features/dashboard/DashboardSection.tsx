import { Card, ErrorState } from '@/components/ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';

/**
 * One dashboard card, isolated from the others.
 *
 * A render crash in the water card must not take the calorie card, the header
 * and the navigation down with it — which is what an unguarded subtree does in
 * React. Each section gets its own boundary, so the worst case is one card
 * replaced by a retry prompt on a screen that otherwise still works.
 *
 * The fallback is deliberately card-shaped: the layout should not reflow around
 * the failure, because a dashboard that rearranges itself when something breaks
 * is harder to read than one that shows a gap where the card was.
 */
export function DashboardSection({
  name,
  children,
}: {
  /** Used in the failure message, so the user knows which part is missing. */
  name: string;
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={(reset) => (
        <Card>
          <ErrorState
            title={`${name} could not be shown`}
            description="The rest of your dashboard is unaffected, and nothing was lost."
            onRetry={reset}
          />
        </Card>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
