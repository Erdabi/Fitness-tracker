import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';
import { DAILY_SCAN_LIMIT } from './limits.ts';

/**
 * Per-user scan quota.
 *
 * Counted in Postgres rather than in memory, because Edge Functions are
 * horizontally scaled and an in-process counter would reset on every cold
 * start — which is to say, it would not be a limit at all.
 *
 * The ledger is written with the service role and has no insert policy for
 * users: a client able to write its own usage rows could also delete them.
 */

export interface QuotaDecision {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
}

export async function checkQuota(
  service: SupabaseClient,
  userId: string,
): Promise<QuotaDecision> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await service
    .from('ai_scan_requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);

  /*
   * Fail open on a ledger error, deliberately. The quota exists to bound cost
   * against a runaway client, not to gate access — refusing every scan because
   * a counting query failed would turn a minor fault into an outage. The error
   * is logged by the caller.
   */
  if (error) return { allowed: true, used: 0, limit: DAILY_SCAN_LIMIT };

  const used = count ?? 0;
  return { allowed: used < DAILY_SCAN_LIMIT, used, limit: DAILY_SCAN_LIMIT };
}

/**
 * Records a request against the quota.
 *
 * Written after the provider call so a failed analysis does not consume a
 * user's allowance, and carrying the outcome so the ledger doubles as the
 * operational record. It stores no image and no extracted nutrition — only
 * that a scan of a given kind happened, how big it was, and how it went.
 */
export async function recordScan(
  service: SupabaseClient,
  entry: {
    userId: string;
    operation: string;
    outcome: string;
    imageBytes: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<void> {
  const { error } = await service.from('ai_scan_requests').insert({
    user_id: entry.userId,
    operation: entry.operation,
    outcome: entry.outcome,
    image_bytes: entry.imageBytes,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
  });

  if (error) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        operation: 'quota.record',
        outcome: 'error',
        detail: error.message.slice(0, 200),
      }),
    );
  }
}
