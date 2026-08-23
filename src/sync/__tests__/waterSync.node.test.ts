import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import {
  deleteWaterLog,
  editWaterLog,
  listWaterDay,
  logWater,
  openWaterGoal,
  waterDay,
  waterGoalForDate,
} from '@/db/repositories/water';
import type { SqlDatabase } from '@/db/types';
import { asLocalDay } from '@/lib/date';
import { sync } from '../engine';
import { countPending } from '../outbox';
import { createFakeRemote, type FakeRemote } from './fakeRemote';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * Water, offline and across devices.
 *
 * Water uses the existing engine, outbox and RemoteAdapter unchanged — there
 * is no water-specific sync anywhere. These scenarios exist to prove exactly
 * that: the same nine situations the diary was held to, applied to a table
 * that added no machinery of its own.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ZURICH = 'Europe/Zurich';
const DAY = asLocalDay('2026-06-15');
/** 2026-06-15 08:00 Zurich. */
const MORNING = Date.parse('2026-06-15T06:00:00.000Z');

function seedUser(db: SqlDatabase, userId: string): void {
  db.run(
    `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
     VALUES (?, 'sam@example.com', 'metric', 'Europe/Zurich', 1000, 1000)`,
    [userId],
  );
}

describe('water sync', () => {
  let phone: SqlDatabase & { close: () => void };
  let tablet: SqlDatabase & { close: () => void };
  let remote: FakeRemote;

  beforeEach(() => {
    phone = createTestDatabase();
    tablet = createTestDatabase();
    migrate(phone);
    migrate(tablet);
    remote = createFakeRemote();
    seedUser(phone, USER);
    seedUser(tablet, USER);
  });

  afterEach(() => {
    phone.close();
    tablet.close();
  });

  const syncPhone = () => sync({ db: phone, userId: USER, remote });
  const syncTablet = () => sync({ db: tablet, userId: USER, remote });

  const drink = (db: SqlDatabase, ml: number, at = MORNING) =>
    logWater({ userId: USER, amountMl: ml, timeZone: ZURICH, at }, db);

  it('1. pushes water logged online', async () => {
    const row = drink(phone, 250);

    const outcome = await syncPhone();

    expect(outcome.error).toBeNull();
    expect(countPending(phone)).toBe(0);
    expect(remote.find('water_logs', row.id)).toMatchObject({
      amount_ml: 250,
      local_date: '2026-06-15',
      time_zone: ZURICH,
    });
  });

  it('2. logs water offline and counts it immediately', async () => {
    remote.goOffline();
    const row = drink(phone, 500);

    // In the total before the network is ever consulted.
    expect(waterDay(USER, DAY, phone).consumedMl).toBe(500);

    await syncPhone();
    expect(countPending(phone)).toBe(1);
    expect(remote.find('water_logs', row.id)).toBeUndefined();

    remote.goOnline();
    // The failed attempt scheduled a 2 s backoff, so a sync fired the instant
    // the radio returns finds nothing due yet. That is intended.
    await syncPhone();
    expect(countPending(phone)).toBe(1);

    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(countPending(phone)).toBe(0);
    expect(remote.find('water_logs', row.id)).toBeDefined();
  });

  it('3. sends the final amount after several offline edits', async () => {
    remote.goOffline();
    const row = drink(phone, 250);
    editWaterLog(row.id, { amountMl: 400, at: MORNING + 1000 }, phone);
    editWaterLog(row.id, { amountMl: 600, at: MORNING + 2000 }, phone);

    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    // Each outbox entry carries the whole row, so whichever lands last is
    // complete rather than a fragment.
    expect(remote.find('water_logs', row.id)?.amount_ml).toBe(600);
    expect(countPending(phone)).toBe(0);
  });

  it('4. delivers water to the user other device', async () => {
    drink(phone, 250);
    drink(phone, 500, MORNING + 3_600_000);
    await syncPhone();
    await syncTablet();

    expect(waterDay(USER, DAY, tablet).consumedMl).toBe(750);
    expect(listWaterDay(USER, DAY, tablet)).toHaveLength(2);
  });

  it('5. carries the local day rather than re-deriving it', async () => {
    // Logged in Honolulu, where the local day and the UTC day disagree.
    const row = logWater(
      {
        userId: USER,
        amountMl: 250,
        timeZone: 'Pacific/Honolulu',
        at: Date.parse('2026-06-15T08:00:00.000Z'),
      },
      phone,
    );
    expect(row.local_date).toBe('2026-06-14');

    await syncPhone();
    await syncTablet();

    // The tablet is in Zurich and must not re-date the entry into its own
    // zone, nor into the UTC day.
    expect(listWaterDay(USER, asLocalDay('2026-06-14'), tablet)).toHaveLength(1);
    expect(listWaterDay(USER, asLocalDay('2026-06-15'), tablet)).toHaveLength(0);
  });

  it('6. delivers an edit to the other device', async () => {
    const row = drink(phone, 250);
    await syncPhone();
    await syncTablet();

    editWaterLog(row.id, { amountMl: 750, at: MORNING + 10_000 }, phone);
    await syncPhone();
    await syncTablet();

    expect(waterDay(USER, DAY, tablet).consumedMl).toBe(750);
    expect(listWaterDay(USER, DAY, tablet)).toHaveLength(1);
  });

  it('7. removes a deleted entry from the other device', async () => {
    const row = drink(phone, 250);
    drink(phone, 500, MORNING + 1_000);
    await syncPhone();
    await syncTablet();
    expect(waterDay(USER, DAY, tablet).consumedMl).toBe(750);

    deleteWaterLog(row.id, phone, MORNING + 10_000);
    await syncPhone();
    await syncTablet();

    expect(waterDay(USER, DAY, tablet).consumedMl).toBe(500);
  });

  it('8. does not resurrect an entry deleted offline', async () => {
    const row = drink(phone, 250);
    await syncPhone();

    remote.goOffline();
    deleteWaterLog(row.id, phone, MORNING + 10_000);
    expect(waterDay(USER, DAY, phone).consumedMl).toBe(0);

    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();
    await syncPhone();
    await syncPhone();

    expect(waterDay(USER, DAY, phone).consumedMl).toBe(0);
    expect(remote.find('water_logs', row.id)?.deleted_at).toBeTruthy();
    expect(countPending(phone)).toBe(0);
  });

  it('9. never sends an entry created and deleted before it reached the server', async () => {
    remote.goOffline();
    const row = drink(phone, 250);
    deleteWaterLog(row.id, phone, MORNING + 1000);

    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(remote.find('water_logs', row.id)?.deleted_at).toBeTruthy();
    expect(waterDay(USER, DAY, phone).consumedMl).toBe(0);
    expect(countPending(phone)).toBe(0);
  });

  it('10. retries a rejected write without duplicating the entry', async () => {
    drink(phone, 250);
    remote.failWrites(1);

    await syncPhone();
    expect(countPending(phone)).toBe(1);
    expect(remote.rows('water_logs')).toHaveLength(0);

    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(countPending(phone)).toBe(0);
    expect(remote.rows('water_logs')).toHaveLength(1);
    expect(waterDay(USER, DAY, phone).consumedMl).toBe(250);
  });

  it('11. keeps an unsent local edit when a pull lands on top of it', async () => {
    const row = drink(phone, 250);
    await syncPhone();
    await syncTablet();

    editWaterLog(row.id, { amountMl: 900, at: MORNING + 5_000 }, tablet);
    await syncTablet();

    remote.goOffline();
    editWaterLog(row.id, { amountMl: 400, at: MORNING + 20_000 }, phone);
    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');

    await syncPhone();

    expect(waterDay(USER, DAY, phone).consumedMl).toBe(400);
    expect(remote.find('water_logs', row.id)?.amount_ml).toBe(400);
  });

  it('12. settles both devices on one version after a concurrent edit', async () => {
    const row = drink(phone, 250);
    await syncPhone();
    await syncTablet();

    editWaterLog(row.id, { amountMl: 300, at: MORNING + 5_000 }, phone);
    editWaterLog(row.id, { amountMl: 700, at: MORNING + 6_000 }, tablet);

    await syncPhone();
    await syncTablet();
    await syncPhone();
    await syncTablet();

    // One entry each — a conflict must never become two glasses.
    expect(listWaterDay(USER, DAY, phone)).toHaveLength(1);
    expect(listWaterDay(USER, DAY, tablet)).toHaveLength(1);
    expect(waterDay(USER, DAY, phone).consumedMl).toBe(
      waterDay(USER, DAY, tablet).consumedMl,
    );
  });

  it('13. changes nothing when run twice over', async () => {
    drink(phone, 250);
    drink(phone, 500, MORNING + 3_600_000);
    await syncPhone();

    const before = listWaterDay(USER, DAY, phone);
    await syncPhone();
    await syncPhone();

    expect(listWaterDay(USER, DAY, phone)).toEqual(before);
    expect(countPending(phone)).toBe(0);
  });

  it('14. produces the same state whether logged online or offline', async () => {
    // Online on one device.
    drink(phone, 250);
    drink(phone, 500, MORNING + 1_000);
    await syncPhone();

    // The same two amounts, logged offline on the other, onto a different day.
    remote.goOffline();
    const other = asLocalDay('2026-06-16');
    logWater(
      { userId: USER, amountMl: 250, timeZone: ZURICH, localDate: other, at: MORNING },
      tablet,
    );
    logWater(
      { userId: USER, amountMl: 500, timeZone: ZURICH, localDate: other, at: MORNING },
      tablet,
    );
    remote.goOnline();
    tablet.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncTablet();
    await syncPhone();

    expect(waterDay(USER, DAY, phone).consumedMl).toBe(750);
    expect(waterDay(USER, other, phone).consumedMl).toBe(750);
    expect(waterDay(USER, DAY, phone).entryCount).toBe(
      waterDay(USER, other, phone).entryCount,
    );
  });

  it('15. never pulls another user water', async () => {
    remote.seed('water_logs', {
      id: 'someone-elses-glass',
      user_id: OTHER,
      amount_ml: 999,
      consumed_at: new Date(MORNING).toISOString(),
      time_zone: ZURICH,
      local_date: '2026-06-15',
      deleted_at: null,
    });

    await syncPhone();

    expect(listWaterDay(USER, DAY, phone)).toHaveLength(0);
    expect(
      phone.get<{ count: number }>('SELECT COUNT(*) AS count FROM water_logs')?.count,
    ).toBe(0);
  });

  describe('water goals', () => {
    const open = (db: SqlDatabase, from: string, targetMl: number, at: number) =>
      openWaterGoal(
        { userId: USER, effectiveFrom: asLocalDay(from), targetMl, at },
        db,
      );

    it('16. never sends the derived period end', async () => {
      open(phone, '2026-06-01', 2400, 1000);
      open(phone, '2026-06-11', 2800, 2000);
      await syncPhone();

      for (const row of remote.rows('water_goals')) {
        expect(row).not.toHaveProperty('effective_to');
      }
    });

    it('17. rebuilds the period chain on the receiving device', async () => {
      open(phone, '2026-06-01', 2400, 1000);
      open(phone, '2026-06-11', 2800, 2000);
      await syncPhone();
      await syncTablet();

      // Derived by the descriptor's afterPull hook, with no manual step.
      expect(waterGoalForDate(USER, asLocalDay('2026-06-05'), tablet)?.target_ml).toBe(2400);
      expect(waterGoalForDate(USER, asLocalDay('2026-06-15'), tablet)?.target_ml).toBe(2800);
    });

    it('18. settles two devices that opened a period on the same day', async () => {
      open(phone, '2026-06-01', 2000, 1000);
      await syncPhone();
      await syncTablet();

      remote.goOffline();
      open(phone, '2026-07-01', 2400, 5000);
      open(tablet, '2026-07-01', 2800, 6000);

      remote.goOnline();
      phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
      tablet.run('UPDATE sync_outbox SET next_attempt_at = 0');

      await syncPhone();
      await syncTablet();
      await syncPhone();

      expect(remote.rows('water_goals')).toHaveLength(3);

      // Both devices agree on which period is in force.
      const onPhone = waterGoalForDate(USER, asLocalDay('2026-07-05'), phone);
      const onTablet = waterGoalForDate(USER, asLocalDay('2026-07-05'), tablet);
      expect(onPhone?.id).toBe(onTablet?.id);

      for (const db of [phone, tablet]) {
        const covering = db.all(
          `SELECT id FROM water_goals
            WHERE user_id = ? AND deleted_at IS NULL AND effective_from <= ?
              AND (effective_to IS NULL OR effective_to >= ?)`,
          [USER, '2026-07-05', '2026-07-05'],
        );
        expect(covering).toHaveLength(1);
      }
    });

    it('19. carries a manual override and its recommendation together', async () => {
      openWaterGoal(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-06-01'),
          targetMl: 2800,
          recommendedMl: 2400,
          basisWeightKg: 68.5,
          at: 1000,
        },
        phone,
      );
      await syncPhone();
      await syncTablet();

      const received = waterGoalForDate(USER, asLocalDay('2026-06-05'), tablet);
      expect(received?.target_ml).toBe(2800);
      expect(received?.calculated_ml).toBe(2400);
      expect(received?.source).toBe('manual');
      expect(received?.basis_weight_kg).toBe(68.5);
    });
  });
});
