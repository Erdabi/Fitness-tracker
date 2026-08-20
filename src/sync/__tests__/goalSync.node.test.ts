import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import {
  currentGoal,
  deleteGoalPeriod,
  editGoalPeriod,
  goalForDate,
  listGoalPeriods,
  openGoalPeriod,
} from '@/db/repositories/goals';
import { latestWeight, recordWeight, weightOn } from '@/db/repositories/weight';
import type { SqlDatabase } from '@/db/types';
import { asLocalDay } from '@/lib/date';
import { sync } from '../engine';
import { countPending } from '../outbox';
import { createFakeRemote, type FakeRemote } from './fakeRemote';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * Goals and weight, offline and across devices.
 *
 * The case that shapes the whole design is scenario 6: two devices each open a
 * goal period while offline. A schema where the client closed the previous
 * period itself would need two writes to land in order, and would leave two
 * periods claiming the same day if only one arrived. Because `effective_to` is
 * derived on both sides, a change of target is one row, and there is no
 * ordering to get wrong.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MACROS = { protein_g: 144, carbohydrates_g: 200, fat_g: 63 };

const BASIS = {
  bmr: 1780,
  tdee: 2759,
  activity: 'moderate' as const,
  direction: 'lose' as const,
  weightKg: 80,
  heightCm: 180,
  ageYears: 30,
  sex: 'male' as const,
};

function seedUser(db: SqlDatabase, userId: string): void {
  db.run(
    `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
     VALUES (?, 'sam@example.com', 'metric', 'Europe/Zurich', 1000, 1000)`,
    [userId],
  );
}

function open(db: SqlDatabase, from: string, calories: number, at: number) {
  return openGoalPeriod(
    {
      userId: USER,
      effectiveFrom: asLocalDay(from),
      targets: { calorieTarget: calories, macros: MACROS },
      recommendation: { calorieTarget: calories, macros: MACROS },
      basis: BASIS,
      at,
    },
    db,
  );
}

describe('goal sync', () => {
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

  it('1. pushes a goal opened online', async () => {
    const goal = open(phone, '2026-08-01', 2000, 1000);

    const outcome = await syncPhone();

    expect(outcome.error).toBeNull();
    expect(countPending(phone)).toBe(0);
    expect(remote.find('nutrition_goals', goal.id)).toMatchObject({
      effective_from: '2026-08-01',
      calorie_target: 2000,
      source: 'calculated',
    });
  });

  it('2. never sends the derived period end', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    open(phone, '2026-08-11', 2200, 2000);
    await syncPhone();

    for (const row of remote.rows('nutrition_goals')) {
      expect(row).not.toHaveProperty('effective_to');
    }
  });

  it('3. sends exactly one row per change of target', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    await syncPhone();
    const afterFirst = remote.stats.upserts;

    open(phone, '2026-08-11', 2200, 2000);
    await syncPhone();

    // Closing the previous period is derived on both sides, so opening a new
    // one is a single write — there is no second row that has to follow it.
    expect(remote.stats.upserts - afterFirst).toBe(1);
  });

  it('4. lets a goal be created offline and read immediately', async () => {
    remote.goOffline();
    open(phone, '2026-08-01', 2000, 1000);

    expect(currentGoal(USER, asLocalDay('2026-08-05'), phone)?.calorie_target).toBe(2000);

    await syncPhone();
    expect(countPending(phone)).toBe(1);

    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(countPending(phone)).toBe(0);
    expect(remote.rows('nutrition_goals')).toHaveLength(1);
  });

  it('5. rebuilds the period chain on the receiving device', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    open(phone, '2026-08-11', 2200, 2000);
    await syncPhone();
    await syncTablet();

    // The tablet was told two start dates; the descriptor's afterPull hook
    // derived the boundaries, with no manual step.
    expect(goalForDate(USER, asLocalDay('2026-08-05'), tablet)?.calorie_target).toBe(2000);
    expect(goalForDate(USER, asLocalDay('2026-08-15'), tablet)?.calorie_target).toBe(2200);

    const periods = listGoalPeriods(USER, tablet);
    expect(periods.map((period) => period.effective_to)).toEqual([null, '2026-08-10']);
  });

  /**
   * The scenario the schema is shaped around. Two devices, both offline, both
   * opening a period the same day. A unique constraint would reject one
   * forever; here both survive and the two devices agree on which is in force.
   */
  it('6. settles two devices that each opened a period on the same day', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    await syncPhone();
    await syncTablet();

    remote.goOffline();
    const fromPhone = open(phone, '2026-09-01', 2200, 5000);
    const fromTablet = openGoalPeriod(
      {
        userId: USER,
        effectiveFrom: asLocalDay('2026-09-01'),
        targets: { calorieTarget: 2400, macros: MACROS },
        recommendation: { calorieTarget: 2400, macros: MACROS },
        basis: BASIS,
        at: 6000,
      },
      tablet,
    );

    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    tablet.run('UPDATE sync_outbox SET next_attempt_at = 0');

    await syncPhone();
    await syncTablet();
    await syncPhone();

    // Both rows survived the round trip.
    expect(remote.rows('nutrition_goals')).toHaveLength(3);

    // And both devices resolve the day to the same period.
    const onPhone = goalForDate(USER, asLocalDay('2026-09-05'), phone);
    const onTablet = goalForDate(USER, asLocalDay('2026-09-05'), tablet);
    expect(onPhone?.id).toBe(onTablet?.id);
    expect(onPhone?.id).toBe(
      // The later creation wins, on both.
      [fromPhone, fromTablet].sort((a, b) => b.created_at - a.created_at)[0]!.id,
    );

    // Exactly one live period covers the date, on each device.
    for (const db of [phone, tablet]) {
      const covering = db.all(
        `SELECT id FROM nutrition_goals
          WHERE user_id = ? AND deleted_at IS NULL AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to >= ?)`,
        [USER, '2026-09-05', '2026-09-05'],
      );
      expect(covering).toHaveLength(1);
    }
  });

  it('7. delivers an edited target to the other device', async () => {
    const goal = open(phone, '2026-08-01', 2000, 1000);
    await syncPhone();
    await syncTablet();

    editGoalPeriod(
      goal.id,
      { targets: { calorieTarget: 2150, macros: MACROS }, at: 3000 },
      phone,
    );
    await syncPhone();
    await syncTablet();

    const received = goalForDate(USER, asLocalDay('2026-08-05'), tablet);
    expect(received?.calorie_target).toBe(2150);
    // The suggestion the edit moved away from travelled with it.
    expect(received?.calculated_calories).toBe(2000);
    expect(received?.source).toBe('calculated_then_modified');
  });

  it('8. removes a deleted period from the other device without resurrecting it', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    const removed = open(phone, '2026-08-11', 2200, 2000);
    await syncPhone();
    await syncTablet();

    deleteGoalPeriod(removed.id, phone, 3000);
    await syncPhone();
    await syncTablet();
    await syncTablet();

    expect(goalForDate(USER, asLocalDay('2026-08-15'), tablet)?.calorie_target).toBe(2000);

    // And it stays gone across further cycles.
    await syncPhone();
    await syncTablet();
    expect(goalForDate(USER, asLocalDay('2026-08-15'), tablet)?.calorie_target).toBe(2000);
  });

  it('9. retries a rejected write without duplicating the period', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    remote.failWrites(1);

    await syncPhone();
    expect(countPending(phone)).toBe(1);

    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(countPending(phone)).toBe(0);
    expect(remote.rows('nutrition_goals')).toHaveLength(1);
  });

  it('10. keeps an unsent local edit when a pull lands on top of it', async () => {
    const goal = open(phone, '2026-08-01', 2000, 1000);
    await syncPhone();
    await syncTablet();

    editGoalPeriod(
      goal.id,
      { targets: { calorieTarget: 2400, macros: MACROS }, at: 4000 },
      tablet,
    );
    await syncTablet();

    remote.goOffline();
    editGoalPeriod(
      goal.id,
      { targets: { calorieTarget: 2100, macros: MACROS }, at: 9000 },
      phone,
    );
    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');

    await syncPhone();

    expect(goalForDate(USER, asLocalDay('2026-08-05'), phone)?.calorie_target).toBe(2100);
    expect(remote.find('nutrition_goals', goal.id)?.calorie_target).toBe(2100);
  });

  it('11. changes nothing when run twice over', async () => {
    open(phone, '2026-08-01', 2000, 1000);
    open(phone, '2026-08-11', 2200, 2000);
    await syncPhone();

    const before = listGoalPeriods(USER, phone);
    await syncPhone();
    await syncPhone();

    expect(listGoalPeriods(USER, phone)).toEqual(before);
    expect(countPending(phone)).toBe(0);
  });

  it('12. never pulls another user goals', async () => {
    remote.seed('nutrition_goals', {
      id: 'someone-elses-goal',
      user_id: OTHER,
      effective_from: '2026-08-01',
      calorie_target: 9999,
      protein_target_g: 100,
      carbohydrate_target_g: 100,
      fat_target_g: 100,
      source: 'manual',
      acknowledged_below_floor: false,
      deleted_at: null,
    });

    await syncPhone();

    expect(listGoalPeriods(USER, phone)).toEqual([]);
    expect(
      phone.get<{ count: number }>('SELECT COUNT(*) AS count FROM nutrition_goals')?.count,
    ).toBe(0);
  });
});

describe('weight sync', () => {
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

  it('carries a weigh-in to the other device', async () => {
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-01'), weightKg: 82.4, at: 1000 },
      phone,
    );

    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    expect(latestWeight(USER, tablet)?.weight_kg).toBe(82.4);
  });

  /**
   * Correcting today's reading is an update, not a second entry — otherwise a
   * typo leaves two measurements behind and every chart shows both.
   */
  it('updates rather than appends when the same day is recorded again', async () => {
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-01'), weightKg: 92.4, at: 1000 },
      phone,
    );
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-01'), weightKg: 82.4, at: 2000 },
      phone,
    );

    await sync({ db: phone, userId: USER, remote });

    expect(remote.rows('weight_entries')).toHaveLength(1);
    expect(remote.rows('weight_entries')[0]!.weight_kg).toBe(82.4);
  });

  it('keeps both readings when two devices weigh in offline on the same day', async () => {
    remote.goOffline();
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-01'), weightKg: 82.4, at: 1000 },
      phone,
    );
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-01'), weightKg: 82.6, at: 2000 },
      tablet,
    );

    remote.goOnline();
    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    tablet.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });
    await sync({ db: phone, userId: USER, remote });

    // Neither is rejected; the later one reads back.
    expect(remote.rows('weight_entries')).toHaveLength(2);
    expect(weightOn(USER, asLocalDay('2026-08-01'), phone)?.weight_kg).toBe(82.6);
  });

  it('carries the last known weight forward rather than inventing one', () => {
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-01'), weightKg: 82.4, at: 1000 },
      phone,
    );
    recordWeight(
      { userId: USER, measuredOn: asLocalDay('2026-08-15'), weightKg: 81.1, at: 2000 },
      phone,
    );

    expect(weightOn(USER, asLocalDay('2026-08-20'), phone)?.weight_kg).toBe(81.1);
    expect(weightOn(USER, asLocalDay('2026-08-10'), phone)?.weight_kg).toBe(82.4);
    expect(weightOn(USER, asLocalDay('2026-07-31'), phone)).toBeUndefined();
  });
});
