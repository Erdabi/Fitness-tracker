import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import {
  getProfile,
  getSettings,
  updateProfile,
  updateSettings,
} from '@/db/repositories/profiles';
import { recordFoodUse } from '@/db/repositories/foodRecents';
import type { SqlDatabase } from '@/db/types';
import { sync } from '../engine';
import { countPending, readCursor, withOutbox } from '../outbox';
import { createFakeRemote, type FakeRemote } from './fakeRemote';

// The repositories import the app's Supabase client for their default remote.
// Every call here injects a fake, so the real client is never constructed.
jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * End-to-end offline behaviour.
 *
 * Drives the real engine, the real outbox and a real SQLite database against
 * an in-memory server. These are the paths that cannot be checked against a
 * live backend and that lose user data when they are wrong.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

describe('offline sync', () => {
  let db: SqlDatabase & { close: () => void };
  let remote: FakeRemote;

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
    remote = createFakeRemote();

    // A signed-in user always has local rows; the server creates them via the
    // handle_new_user trigger, and the client seeds them for offline signup.
    db.run(
      `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
       VALUES (?, 'sam@example.com', 'metric', 'Europe/Zurich', 1000, 1000)`,
      [USER],
    );
    db.run(
      `INSERT INTO user_settings (id, user_id, created_at, updated_at)
       VALUES ('settings-1', ?, 1000, 1000)`,
      [USER],
    );
  });

  afterEach(() => {
    db.close();
  });

  const run = () => sync({ db, userId: USER, remote });

  /* ------------------------------------------------------ 1. create online */

  it('1. pushes a record created while online', async () => {
    updateProfile(USER, { display_name: 'Sam' }, db);

    const outcome = await run();

    expect(outcome.error).toBeNull();
    expect(outcome.pushed).toBe(1);
    expect(countPending(db)).toBe(0);
    expect(remote.find('profiles', USER)?.display_name).toBe('Sam');
  });

  /* ----------------------------------------------------- 2. create offline */

  it('2. keeps a record created while offline and sends it later', async () => {
    remote.goOffline();

    updateProfile(USER, { display_name: 'Offline Sam' }, db);
    const offlineResult = await run();

    // The local write succeeded even though the network did not.
    expect(getProfile(USER, db)?.display_name).toBe('Offline Sam');
    expect(countPending(db)).toBe(1);
    expect(offlineResult.pushed).toBe(0);
    expect(remote.find('profiles', USER)).toBeUndefined();

    remote.goOnline();
    // The entry backed off, so let it become eligible again.
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');

    const onlineResult = await run();

    expect(onlineResult.pushed).toBe(1);
    expect(countPending(db)).toBe(0);
    expect(remote.find('profiles', USER)?.display_name).toBe('Offline Sam');
  });

  /* ----------------------------------------------------- 3. update offline */

  it('3. collapses repeated offline edits into a correct final state', async () => {
    await run(); // establish a cursor and an initial server row

    remote.goOffline();
    updateProfile(USER, { display_name: 'First' }, db);
    updateProfile(USER, { display_name: 'Second' }, db);
    updateProfile(USER, { height_cm: 178 }, db);
    await run();

    expect(countPending(db)).toBe(3);

    remote.goOnline();
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await run();

    const server = remote.find('profiles', USER);
    // Each entry carries the whole row, so the last one written wins and no
    // field is lost — a partial patch would have nulled height_cm here.
    expect(server?.display_name).toBe('Second');
    expect(server?.height_cm).toBe(178);
    expect(countPending(db)).toBe(0);
  });

  /* ----------------------------------------------------- 4. delete offline */

  it('4. queues a delete made while offline and applies it on reconnect', async () => {
    // Get the row onto the server first — a delete is only meaningful for a
    // row the server actually has.
    updateProfile(USER, { display_name: 'To Be Deleted' }, db);
    await run();
    expect(remote.find('profiles', USER)).toBeDefined();

    remote.goOffline();

    const deletedAt = Date.now();
    withOutbox(db, { table: 'profiles', rowId: USER, operation: 'delete' }, () => {
      db.run('UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ?', [
        deletedAt,
        deletedAt,
        USER,
      ]);
    });

    // A soft-deleted row is invisible to the app immediately, offline or not.
    expect(getProfile(USER, db)).toBeUndefined();
    expect(countPending(db)).toBe(1);

    remote.goOnline();
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await run();

    expect(countPending(db)).toBe(0);
    expect(remote.find('profiles', USER)?.deleted_at).not.toBeNull();
  });

  /* --------------------------------------------- 5+6. reconnect and push -- */

  it('5+6. drains the whole backlog on reconnect', async () => {
    remote.goOffline();

    updateProfile(USER, { display_name: 'A' }, db);
    updateSettings(USER, { water_goal_ml: 3000 }, db);
    updateProfile(USER, { height_cm: 180 }, db);
    await run();

    expect(countPending(db)).toBe(3);

    remote.goOnline();
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    const outcome = await run();

    expect(outcome.pushed).toBe(3);
    expect(outcome.error).toBeNull();
    expect(countPending(db)).toBe(0);
    expect(remote.find('profiles', USER)?.height_cm).toBe(180);
    expect(remote.find('user_settings', 'settings-1')?.water_goal_ml).toBe(3000);
  });

  it('5+6. sends a create before the update that follows it', async () => {
    remote.goOffline();
    updateProfile(USER, { display_name: 'First' }, db);
    updateProfile(USER, { display_name: 'Last' }, db);
    await run();

    remote.goOnline();
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await run();

    // Ordering matters: out-of-order delivery would leave "First" on the server.
    expect(remote.find('profiles', USER)?.display_name).toBe('Last');
  });

  /* ------------------------------------------------------------- 7. pull -- */

  it('7. pulls a change made on another device', async () => {
    await run();

    remote.seed('profiles', {
      id: USER,
      email: 'sam@example.com',
      display_name: 'Changed Elsewhere',
      unit_system: 'metric',
      time_zone: 'Europe/Zurich',
      height_cm: 175,
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2026-09-01T10:00:00.000Z',
      deleted_at: null,
    });

    const outcome = await run();

    expect(outcome.pulled).toBeGreaterThan(0);
    expect(getProfile(USER, db)?.display_name).toBe('Changed Elsewhere');
    expect(getProfile(USER, db)?.height_cm).toBe(175);
  });

  it('7. never pulls another user’s rows', async () => {
    remote.seed('profiles', {
      id: OTHER_USER,
      display_name: 'Not Yours',
      unit_system: 'metric',
      time_zone: 'UTC',
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2026-09-01T10:00:00.000Z',
      deleted_at: null,
    });

    await run();

    expect(
      db.get('SELECT id FROM profiles WHERE id = ?', [OTHER_USER]),
    ).toBeUndefined();
  });

  it('7. advances the cursor so a second pull is cheap', async () => {
    // A cursor is only written once a pull has actually seen a row; with an
    // empty server there is nothing to record, and null correctly means
    // "never seen anything".
    updateProfile(USER, { display_name: 'Anything' }, db);
    await run();
    const cursor = readCursor(db, 'profiles');

    expect(cursor).not.toBeNull();

    const before = remote.stats.fetches;
    await run();

    // Still queries, but the cursor means the server has nothing new to send.
    expect(remote.stats.fetches).toBeGreaterThan(before);
    expect(readCursor(db, 'profiles')).toBe(cursor);
  });

  it('7. applies a soft delete arriving from another device', async () => {
    await run();

    remote.seed('profiles', {
      id: USER,
      display_name: 'Sam',
      unit_system: 'metric',
      time_zone: 'Europe/Zurich',
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2026-09-01T10:00:00.000Z',
      deleted_at: '2026-09-01T10:00:00.000Z',
    });

    await run();

    expect(getProfile(USER, db)).toBeUndefined();
  });

  /* --------------------------------------------------------- 8. conflict -- */

  it('8. takes the remote row when it is newer and nothing local is pending', async () => {
    await run();

    remote.seed('profiles', {
      id: USER,
      display_name: 'Remote Wins',
      unit_system: 'metric',
      time_zone: 'Europe/Zurich',
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2026-12-01T10:00:00.000Z',
      deleted_at: null,
    });

    await run();

    expect(getProfile(USER, db)?.display_name).toBe('Remote Wins');
  });

  it('8. keeps the local row when it is newer', async () => {
    await run();

    // Local edit dated far in the future, already pushed and drained.
    db.run('UPDATE profiles SET display_name = ?, updated_at = ? WHERE id = ?', [
      'Local Newer',
      Date.parse('2027-01-01T00:00:00.000Z'),
      USER,
    ]);

    remote.seed('profiles', {
      id: USER,
      display_name: 'Remote Older',
      unit_system: 'metric',
      time_zone: 'Europe/Zurich',
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2026-09-01T10:00:00.000Z',
      deleted_at: null,
    });

    await run();

    expect(getProfile(USER, db)?.display_name).toBe('Local Newer');
  });

  /* --------------------------------- 9. pending local changes are sacred -- */

  it('9. never overwrites an unsynced local edit, even with a newer remote row', async () => {
    await run();

    // The user edits while offline...
    remote.goOffline();
    updateProfile(USER, { display_name: 'What The User Typed' }, db);
    await run();
    expect(countPending(db)).toBe(1);

    // ...and meanwhile another device wrote something much newer.
    remote.goOnline();
    remote.seed('profiles', {
      id: USER,
      display_name: 'Remote Clobber',
      unit_system: 'metric',
      time_zone: 'Europe/Zurich',
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2030-01-01T00:00:00.000Z',
      deleted_at: null,
    });

    // Pull only: the outbox entry is still backing off, so the push half is a
    // no-op and this isolates the guard.
    await run();

    expect(getProfile(USER, db)?.display_name).toBe('What The User Typed');
    expect(countPending(db)).toBe(1);
  });

  it('9. sends the pending edit once it becomes eligible', async () => {
    await run();

    remote.goOffline();
    updateProfile(USER, { display_name: 'Survives' }, db);
    await run();

    remote.goOnline();
    remote.seed('profiles', {
      id: USER,
      display_name: 'Remote Clobber',
      unit_system: 'metric',
      time_zone: 'Europe/Zurich',
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2030-01-01T00:00:00.000Z',
      deleted_at: null,
    });
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');

    await run();

    expect(countPending(db)).toBe(0);
    expect(remote.find('profiles', USER)?.display_name).toBe('Survives');
    expect(getProfile(USER, db)?.display_name).toBe('Survives');
  });

  /* ------------------------------------------------- 10. retry after fail -- */

  it('10. retries after a failed request and eventually succeeds', async () => {
    remote.failWrites(1);

    updateProfile(USER, { display_name: 'Retry Me' }, db);
    const first = await run();

    expect(first.pushed).toBe(0);
    expect(countPending(db)).toBe(1);
    expect(remote.find('profiles', USER)).toBeUndefined();

    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    const second = await run();

    expect(second.pushed).toBe(1);
    expect(countPending(db)).toBe(0);
    expect(remote.find('profiles', USER)?.display_name).toBe('Retry Me');
  });

  it('10. records the failure and backs the entry off', async () => {
    remote.failWrites(1);
    updateProfile(USER, { display_name: 'Retry Me' }, db);
    await run();

    const entry = db.get<{ attempts: number; next_attempt_at: number; last_error: string }>(
      'SELECT attempts, next_attempt_at, last_error FROM sync_outbox LIMIT 1',
    );

    expect(entry?.attempts).toBe(1);
    expect(entry?.last_error).toContain('rejected');
    expect(entry?.next_attempt_at).toBeGreaterThan(Date.now());
  });

  it('10. a failed cycle reports the error instead of throwing', async () => {
    remote.goOffline();

    // A pull failure is a thrown network error; it must surface as a result.
    const outcome = await run();

    expect(outcome.error).not.toBeNull();
    expect(countPending(db)).toBe(0);
  });

  it('10. a failed push does not advance the cursor or lose the queue', async () => {
    await run();
    const cursorBefore = readCursor(db, 'profiles');

    remote.goOffline();
    updateProfile(USER, { display_name: 'Pending' }, db);
    await run();

    expect(readCursor(db, 'profiles')).toBe(cursorBefore);
    expect(countPending(db)).toBe(1);
    expect(getProfile(USER, db)?.display_name).toBe('Pending');
  });

  it('10. is safe to run repeatedly while offline', async () => {
    remote.goOffline();
    updateProfile(USER, { display_name: 'Stubborn' }, db);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      db.run('UPDATE sync_outbox SET next_attempt_at = 0');
      await run();
    }

    // Still queued, still intact, attempts recorded rather than duplicated.
    expect(countPending(db)).toBe(1);
    expect(getProfile(USER, db)?.display_name).toBe('Stubborn');

    remote.goOnline();
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await run();

    expect(remote.find('profiles', USER)?.display_name).toBe('Stubborn');
  });

  /* -------------------------------------------------------- type mapping -- */

  /**
   * SQLite has no boolean type, Postgres has no 0/1 coercion over PostgREST.
   * The descriptor's toRemote is what bridges them, and before it ran at send
   * time this pushed an integer into a boolean column.
   */
  it('maps SQLite integers to real booleans on the wire', async () => {
    updateSettings(USER, { exercise_adds_calories: 1 }, db);
    await run();

    expect(remote.find('user_settings', 'settings-1')?.exercise_adds_calories).toBe(
      true,
    );
  });

  it('maps booleans back to SQLite integers on pull', async () => {
    await run();

    remote.seed('user_settings', {
      id: 'settings-1',
      user_id: USER,
      theme: 'dark',
      water_goal_ml: 3200,
      exercise_adds_calories: true,
      created_at: '2026-08-19T10:00:00.000Z',
      updated_at: '2026-12-01T10:00:00.000Z',
      deleted_at: null,
    });

    await run();

    const settings = getSettings(USER, db);
    expect(settings?.exercise_adds_calories).toBe(1);
    expect(settings?.theme).toBe('dark');
    expect(settings?.water_goal_ml).toBe(3200);
  });

  /* ----------------------------------------------------- cursor overlap --- */

  /**
   * The cursor is rewound before each query so a row committed late — with a
   * timestamp behind a cursor already advanced past — is still seen. Re-reading
   * that window must be harmless.
   */
  it('re-applying an already-seen row is a no-op', async () => {
    updateProfile(USER, { display_name: 'Stable' }, db);
    await run();

    const afterFirst = getProfile(USER, db);

    await run();
    await run();

    const afterThird = getProfile(USER, db);
    expect(afterThird?.display_name).toBe('Stable');
    expect(afterThird?.updated_at).toBe(afterFirst?.updated_at);
  });

  /* ----------------------------------------------------- recent foods --- */

  /**
   * Recently used foods are user-owned, so they ride the same offline path as
   * everything else: logged locally now, pushed when there is a connection.
   */
  describe('food_recents', () => {
    const FOOD = '33333333-3333-4333-8333-333333333333';

    it('records a use offline and pushes it on reconnect', async () => {
      remote.goOffline();

      recordFoodUse({ userId: USER, foodId: FOOD, at: 1_700_000_000_000 }, db);

      expect(countPending(db)).toBe(1);
      expect(remote.find('food_recents', FOOD)).toBeUndefined();

      remote.goOnline();
      db.run('UPDATE sync_outbox SET next_attempt_at = 0');
      const outcome = await run();

      expect(outcome.pushed).toBe(1);
      expect(remote.rows('food_recents')).toHaveLength(1);
    });

    /** Epoch millis locally, timestamptz on the wire — toRemote bridges them. */
    it('converts the local timestamp to ISO on the wire', async () => {
      recordFoodUse({ userId: USER, foodId: FOOD, at: 1_700_000_000_000 }, db);
      await run();

      const pushed = remote.rows('food_recents')[0];
      expect(pushed?.last_used_at).toBe('2023-11-14T22:13:20.000Z');
      expect(pushed?.use_count).toBe(1);
    });

    it('pulls a use recorded on another device', async () => {
      await run();

      remote.seed('food_recents', {
        id: 'recent-1',
        user_id: USER,
        food_id: FOOD,
        last_used_at: '2026-09-01T10:00:00.000Z',
        use_count: 7,
        created_at: '2026-08-19T10:00:00.000Z',
        updated_at: '2026-09-01T10:00:00.000Z',
        deleted_at: null,
      });

      await run();

      const local = db.get<{ use_count: number; last_used_at: number }>(
        'SELECT use_count, last_used_at FROM food_recents WHERE id = ?',
        ['recent-1'],
      );
      expect(local?.use_count).toBe(7);
      expect(local?.last_used_at).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    });

    it('never pulls another user’s recents', async () => {
      remote.seed('food_recents', {
        id: 'not-mine',
        user_id: OTHER_USER,
        food_id: FOOD,
        last_used_at: '2026-09-01T10:00:00.000Z',
        use_count: 3,
        created_at: '2026-08-19T10:00:00.000Z',
        updated_at: '2026-09-01T10:00:00.000Z',
        deleted_at: null,
      });

      await run();

      expect(db.get('SELECT 1 FROM food_recents WHERE id = ?', ['not-mine'])).toBeUndefined();
    });
  });
});
