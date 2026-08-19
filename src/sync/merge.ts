/**
 * Conflict resolution.
 *
 * Kept pure and dependency-free: this is the logic most likely to lose user
 * data if it is wrong, so it must be directly testable without a database, a
 * network, or a React tree.
 */

export type MergeDecision =
  /** Overwrite the local row with the server's version. */
  | 'accept-remote'
  /** Leave the local row alone. */
  | 'keep-local';

export interface MergeInput {
  /** Local logical modification time (epoch ms), or null if the row is new. */
  readonly localUpdatedAt: number | null;
  /** Server modification time (epoch ms). */
  readonly remoteUpdatedAt: number;
  /**
   * Whether the local row has unsent writes sitting in the outbox.
   *
   * This is the guard that matters. Without it, a pull that lands between a
   * local edit and its push silently discards what the user just typed.
   */
  readonly hasPendingLocalChange: boolean;
}

export function resolve({
  localUpdatedAt,
  remoteUpdatedAt,
  hasPendingLocalChange,
}: MergeInput): MergeDecision {
  // A row the user has edited but not yet pushed always wins. The outbox will
  // send it, and the server's copy becomes stale the moment that lands.
  if (hasPendingLocalChange) return 'keep-local';

  // Row does not exist locally — nothing to lose.
  if (localUpdatedAt === null) return 'accept-remote';

  // Last write wins. Ties keep local: re-applying an identical row would
  // churn the UI for no benefit.
  return remoteUpdatedAt > localUpdatedAt ? 'accept-remote' : 'keep-local';
}

/**
 * Advances a pull cursor.
 *
 * The cursor is the server's `updated_at` (ISO 8601), not a device timestamp —
 * device clocks drift and would skip rows. Compared as instants rather than
 * strings so differing precision or offsets cannot cause a regression.
 */
export function advanceCursor(
  current: string | null,
  candidates: readonly (string | null)[],
): string | null {
  let best = current;
  let bestMs = current ? Date.parse(current) : Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      best = candidate;
      bestMs = ms;
    }
  }

  return best;
}

/**
 * Backoff before an outbox entry is retried.
 *
 * Exponential with a ceiling, so a server outage does not turn into a hot loop
 * draining the battery, and a transient failure still recovers quickly.
 */
export function retryDelayMs(attempts: number): number {
  const BASE_MS = 2_000;
  const CEILING_MS = 5 * 60_000;
  return Math.min(BASE_MS * 2 ** Math.max(0, attempts - 1), CEILING_MS);
}

/**
 * Whether an entry should be abandoned.
 *
 * An entry that fails this many times is not transiently broken — it is
 * malformed or rejected by a constraint, and retrying forever would block
 * every write queued behind it.
 */
export const MAX_OUTBOX_ATTEMPTS = 8;

export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_OUTBOX_ATTEMPTS;
}
