import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import { MAX_OUTBOX_ATTEMPTS } from '../merge';
import {
  claimReady,
  countPending,
  enqueue,
  hasPendingChange,
  markFailed,
  markSucceeded,
  readCursor,
  withOutbox,
  writeCursor,
} from '../outbox';
import type { OutboxEntry } from '../types';

describe('outbox', () => {
  let db: ReturnType<typeof createTestDatabase>;

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedProfile(id = 'user-1'): void {
    db.run(
      `INSERT INTO profiles (id, unit_system, time_zone, created_at, updated_at)
       VALUES (?, 'metric', 'UTC', 1, 1)`,
      [id],
    );
  }

  it('queues an entry that is immediately ready to send', () => {
    enqueue(db, {
      table: 'profiles',
      rowId: 'user-1',
      operation: 'upsert',
      payload: { id: 'user-1', display_name: 'Sam' },
    });

    const ready = claimReady(db);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.row_id).toBe('user-1');
    expect(countPending(db)).toBe(1);
  });

  it('drains in insertion order so a create precedes its update', () => {
    for (const name of ['first', 'second', 'third']) {
      enqueue(db, {
        table: 'profiles',
        rowId: name,
        operation: 'upsert',
        payload: { id: name },
      });
    }

    expect(claimReady(db).map((entry) => entry.row_id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  /**
   * The atomicity guarantee. If the row write and the queue entry could commit
   * separately, a crash between them silently loses the change.
   */
  it('commits the row and its queue entry together', () => {
    seedProfile();

    withOutbox(
      db,
      { table: 'profiles', rowId: 'user-1', operation: 'upsert' },
      () => {
        db.run('UPDATE profiles SET display_name = ? WHERE id = ?', ['Sam', 'user-1']);
      },
    );

    expect(countPending(db)).toBe(1);
    expect(
      db.get<{ display_name: string }>('SELECT display_name FROM profiles WHERE id = ?', [
        'user-1',
      ])?.display_name,
    ).toBe('Sam');
  });

  /**
   * The payload must be the full row. `descriptor.toRemote` runs at send time
   * and needs every column; a partial patch would map absent fields to null
   * and wipe server data on upsert.
   */
  it('queues the full row rather than the caller\'s patch', () => {
    seedProfile();

    withOutbox(db, { table: 'profiles', rowId: 'user-1', operation: 'upsert' }, () => {
      db.run('UPDATE profiles SET display_name = ? WHERE id = ?', ['Sam', 'user-1']);
    });

    const entry = claimReady(db)[0] as OutboxEntry;
    const payload = JSON.parse(entry.payload) as Record<string, unknown>;

    expect(payload.id).toBe('user-1');
    expect(payload.display_name).toBe('Sam');
    expect(payload.unit_system).toBe('metric');
    expect(payload).toHaveProperty('time_zone');
    expect(payload).toHaveProperty('updated_at');
  });

  it('queues nothing when the row write fails', () => {
    seedProfile();

    expect(() =>
      withOutbox(db, { table: 'profiles', rowId: 'user-1', operation: 'upsert' }, () => {
        db.run('UPDATE nonexistent_table SET x = 1');
      }),
    ).toThrow();

    expect(countPending(db)).toBe(0);
  });

  it('reports pending changes per row', () => {
    enqueue(db, {
      table: 'profiles',
      rowId: 'user-1',
      operation: 'upsert',
      payload: {},
    });

    expect(hasPendingChange(db, 'profiles', 'user-1')).toBe(true);
    expect(hasPendingChange(db, 'profiles', 'user-2')).toBe(false);
    expect(hasPendingChange(db, 'user_settings', 'user-1')).toBe(false);
  });

  it('removes an entry once it succeeds', () => {
    enqueue(db, { table: 'profiles', rowId: 'r', operation: 'upsert', payload: {} });
    const entry = claimReady(db)[0] as OutboxEntry;

    markSucceeded(db, entry.id);

    expect(countPending(db)).toBe(0);
  });

  it('backs off a failed entry instead of retrying immediately', () => {
    enqueue(db, { table: 'profiles', rowId: 'r', operation: 'upsert', payload: {} });
    const entry = claimReady(db)[0] as OutboxEntry;

    const abandoned = markFailed(db, entry, 'network down');

    expect(abandoned).toBe(false);
    expect(countPending(db)).toBe(1);
    // Still queued, but not yet eligible.
    expect(claimReady(db)).toHaveLength(0);
  });

  it('abandons an entry that keeps failing, so it cannot block the queue', () => {
    enqueue(db, { table: 'profiles', rowId: 'r', operation: 'upsert', payload: {} });
    const entry = claimReady(db)[0] as OutboxEntry;

    const abandoned = markFailed(
      db,
      { ...entry, attempts: MAX_OUTBOX_ATTEMPTS - 1 },
      'rejected by constraint',
    );

    expect(abandoned).toBe(true);
    expect(countPending(db)).toBe(0);
  });

  it('truncates a long error rather than storing an unbounded blob', () => {
    enqueue(db, { table: 'profiles', rowId: 'r', operation: 'upsert', payload: {} });
    const entry = claimReady(db)[0] as OutboxEntry;

    markFailed(db, entry, 'x'.repeat(5000));

    const stored = db.get<{ last_error: string }>(
      'SELECT last_error FROM sync_outbox WHERE id = ?',
      [entry.id],
    );
    expect(stored?.last_error.length).toBeLessThanOrEqual(500);
  });
});

describe('sync cursor', () => {
  let db: ReturnType<typeof createTestDatabase>;

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', () => {
    expect(readCursor(db, 'profiles')).toBeNull();
  });

  it('round-trips a value', () => {
    writeCursor(db, 'profiles', '2026-08-19T12:00:00Z');
    expect(readCursor(db, 'profiles')).toBe('2026-08-19T12:00:00Z');
  });

  it('overwrites rather than duplicating on a second write', () => {
    writeCursor(db, 'profiles', '2026-08-19T12:00:00Z');
    writeCursor(db, 'profiles', '2026-08-20T12:00:00Z');

    expect(readCursor(db, 'profiles')).toBe('2026-08-20T12:00:00Z');
    expect(
      db.all<{ table_name: string }>('SELECT table_name FROM sync_state'),
    ).toHaveLength(1);
  });

  it('tracks tables independently', () => {
    writeCursor(db, 'profiles', '2026-08-19T12:00:00Z');
    expect(readCursor(db, 'user_settings')).toBeNull();
  });
});
