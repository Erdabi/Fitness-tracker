import { View } from 'react-native';

import { Text } from '@/components/ui';
import type { SyncStatus } from '@/sync/types';
import { useTheme } from '@/theme';

/**
 * What the diary is doing behind the screen.
 *
 * Renders nothing when everything is settled, which is nearly always. The
 * cases that do show up are the ones where silence would be a lie: entries
 * waiting to be sent, and a sync that failed.
 *
 * Deliberately not an error dialog. Nothing here blocks the user or is theirs
 * to fix — their entries are safely on the device and will go out on their own.
 * The notice exists so that somebody who has been logging on a plane knows why
 * their other device has not caught up yet.
 */
export function SyncNotice({ status }: { status: SyncStatus }) {
  const theme = useTheme();

  const message = describe(status);
  if (!message) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: message.tone === 'warning'
          ? theme.colors.warningMuted
          : theme.colors.surfaceMuted,
      }}
    >
      <Text variant="caption" color={message.tone === 'warning' ? 'warning' : 'muted'}>
        {message.text}
      </Text>
    </View>
  );
}

function describe(
  status: SyncStatus,
): { text: string; tone: 'muted' | 'warning' } | null {
  if (status.lastError && status.pendingCount > 0) {
    return {
      tone: 'warning',
      text: `${status.pendingCount} ${plural(status.pendingCount)} saved on this device — not synced yet.`,
    };
  }

  if (status.pendingCount > 0) {
    return {
      tone: 'muted',
      text:
        status.phase === 'idle'
          ? `${status.pendingCount} ${plural(status.pendingCount)} waiting to sync.`
          : 'Syncing…',
    };
  }

  return null;
}

function plural(count: number): string {
  return count === 1 ? 'change' : 'changes';
}
