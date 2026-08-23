import { useQuery } from '@tanstack/react-query';

import { getDatabase } from '@/db/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { useDiaryTimeZone } from '@/features/diary/useDiary';
import { todayIn, type LocalDay } from '@/lib/date';
import { loadDashboard, type DashboardSummary } from './dashboardService';

/**
 * The dashboard's data, as one query.
 *
 * One query rather than one per card, so the six reads happen together and the
 * screen has a single loading state to reason about — and so a card cannot
 * quietly add a seventh by growing its own hook.
 */
export function useDashboard(day?: LocalDay): {
  summary: DashboardSummary | null;
  today: LocalDay;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const today = todayIn(timeZone);
  const target = day ?? today;

  const query = useQuery({
    queryKey: ['dashboard', userId ?? 'anonymous', target],
    enabled: userId !== null,
    queryFn: () => (userId ? loadDashboard(userId, target, getDatabase()) : null),
  });

  return {
    summary: query.data ?? null,
    today,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
