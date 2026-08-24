import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';

/**
 * Who is calling.
 *
 * The caller's own JWT is verified by asking Supabase to resolve it — the
 * function never decodes or trusts a token itself. An unauthenticated request
 * is rejected before an image is even read, so an anonymous caller cannot make
 * this project pay for a vision request.
 */

export interface Caller {
  readonly userId: string;
  /** Scoped to the caller, subject to RLS. Used for anything they own. */
  readonly client: SupabaseClient;
}

export async function authenticate(request: Request): Promise<Caller | null> {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) return null;

  /*
   * The ANON key with the caller's token attached — not the service role.
   * Every query this client makes is still subject to RLS, so a bug here
   * cannot read another user's rows.
   */
  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;

  return { userId: data.user.id, client };
}

/**
 * A service-role client, for the quota ledger only.
 *
 * The ledger has no RLS policy granting inserts — usage is recorded *about* a
 * user, not *by* them, and a client that could write its own usage rows could
 * erase its own quota. This is the only place the service role is used, and it
 * never leaves the function.
 */
export function serviceClient(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
