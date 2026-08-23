import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import type { SqlDatabase } from '@/db/types';
import { addDays, asLocalDay, localDayFor } from '@/lib/date';
import {
  deleteWaterGoal,
  deleteWaterLog,
  editWaterLog,
  listWaterDay,
  listWaterGoalPeriods,
  logWater,
  openWaterGoal,
  summariseWater,
  waterDay,
  waterGoalForDate,
  waterHistory,
} from '../water';

/**
 * The water store.
 *
 * Three properties carry the weight: the local day is the user's day, a
 * deleted entry contributes nothing, and a historical day keeps the goal that
 * applied on it. Each is asserted by changing something and reading the past
 * back, not by inspecting the schema.
 */

const USER = 'user-alice';
const OTHER = 'user-bob';
const ZURICH = 'Europe/Zurich';

/** 2026-06-15 08:00 Zurich. */
const MORNING = Date.parse('2026-06-15T06:00:00.000Z');

describe('water logs', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  const drink = (ml: number, at = MORNING, overrides = {}) =>
    logWater({ userId: USER, amountMl: ml, timeZone: ZURICH, at, ...overrides }, db);

  describe('logging', () => {
    it('records an amount in millilitres', () => {
      const row = drink(250);

      expect(row.amount_ml).toBe(250);
      expect(row.local_date).toBe('2026-06-15');
      expect(row.time_zone).toBe(ZURICH);
    });

    /**
     * Every quick-add button and the custom field go through one service.
     * If they diverged, four buttons would be four chances to get the day
     * wrong.
     */
    it('treats every amount identically, whatever produced it', () => {
      const rows = [250, 500, 750, 1000, 333].map((ml) => drink(ml));

      for (const row of rows) {
        expect(row.local_date).toBe('2026-06-15');
        expect(row.user_id).toBe(USER);
      }
      expect(rows.map((row) => row.amount_ml)).toEqual([250, 500, 750, 1000, 333]);
    });

    it('rounds a fractional amount rather than storing it', () => {
      expect(drink(249.6).amount_ml).toBe(250);
    });

    it('refuses an amount that cannot mean anything', () => {
      expect(() => drink(0)).toThrow(/positive amount/);
      expect(() => drink(-250)).toThrow(/positive amount/);
      expect(() => drink(Number.NaN)).toThrow();
    });

    it('queues the entry for sync in the same transaction as the write', () => {
      const row = drink(500);

      const queued = db.all<{ row_id: string; operation: string; payload: string }>(
        'SELECT row_id, operation, payload FROM sync_outbox',
      );

      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ row_id: row.id, operation: 'upsert' });
      expect(JSON.parse(queued[0]!.payload)).toMatchObject({
        amount_ml: 500,
        local_date: '2026-06-15',
      });
    });
  });

  describe('the local day is the user day', () => {
    it('puts a late-evening glass on that evening', () => {
      // 23:30 in Zurich on the 15th.
      expect(drink(250, Date.parse('2026-06-15T21:30:00.000Z')).local_date).toBe(
        '2026-06-15',
      );
    });

    it('puts an after-midnight glass on the new local day', () => {
      // 00:30 in Zurich on the 16th, still the 15th in UTC.
      expect(drink(250, Date.parse('2026-06-15T22:30:00.000Z')).local_date).toBe(
        '2026-06-16',
      );
    });

    it('follows a zone behind UTC', () => {
      // 22:00 on the 14th in Honolulu; the UTC day is the 15th.
      const row = logWater(
        {
          userId: USER,
          amountMl: 250,
          timeZone: 'Pacific/Honolulu',
          at: Date.parse('2026-06-15T08:00:00.000Z'),
        },
        db,
      );

      expect(row.local_date).toBe('2026-06-14');
      expect(new Date(row.consumed_at).toISOString().slice(0, 10)).toBe('2026-06-15');
    });

    it('follows a zone ahead of UTC', () => {
      // 23:30 on the 14th in Auckland; the UTC day is the 14th too, but the
      // opposite boundary is the one that matters.
      const row = logWater(
        {
          userId: USER,
          amountMl: 250,
          timeZone: 'Pacific/Auckland',
          at: Date.parse('2026-06-14T23:00:00.000Z'),
        },
        db,
      );

      expect(row.local_date).toBe('2026-06-15');
    });

    it('resolves one local day on both sides of a daylight-saving change', () => {
      const first = drink(250, Date.parse('2026-10-25T00:30:00.000Z'));
      const second = drink(250, Date.parse('2026-10-25T01:30:00.000Z'));

      expect(first.local_date).toBe('2026-10-25');
      expect(second.local_date).toBe('2026-10-25');
    });

    it('moves the instant with the entry when logging onto another day', () => {
      const row = drink(250, MORNING, { localDate: asLocalDay('2026-06-13') });

      expect(row.local_date).toBe('2026-06-13');
      expect(localDayFor(new Date(row.consumed_at), ZURICH)).toBe('2026-06-13');
    });

    it('leaves historical entries where they were when the user travels', () => {
      const home = drink(250);
      logWater(
        {
          userId: USER,
          amountMl: 500,
          timeZone: 'Asia/Tokyo',
          at: Date.parse('2026-06-20T16:00:00.000Z'),
        },
        db,
      );

      const unchanged = db.get<{ local_date: string; time_zone: string }>(
        'SELECT local_date, time_zone FROM water_logs WHERE id = ?',
        [home.id],
      );
      expect(unchanged).toEqual({ local_date: '2026-06-15', time_zone: ZURICH });
    });
  });

  describe('editing and deleting', () => {
    it('moves the day total with an edited amount', () => {
      const row = drink(250);
      expect(waterDay(USER, asLocalDay('2026-06-15'), db).consumedMl).toBe(250);

      editWaterLog(row.id, { amountMl: 400, at: MORNING + 1000 }, db);

      expect(waterDay(USER, asLocalDay('2026-06-15'), db).consumedMl).toBe(400);
    });

    it('re-dates an entry only by moving it', () => {
      const row = drink(250);
      const moved = editWaterLog(row.id, { localDate: asLocalDay('2026-06-10') }, db);

      expect(moved.local_date).toBe('2026-06-10');
      expect(localDayFor(new Date(moved.consumed_at), ZURICH)).toBe('2026-06-10');
      expect(listWaterDay(USER, asLocalDay('2026-06-15'), db)).toHaveLength(0);
      expect(listWaterDay(USER, asLocalDay('2026-06-10'), db)).toHaveLength(1);
    });

    it('removes an entry from the total immediately, with no network', () => {
      const row = drink(250);
      drink(500);

      deleteWaterLog(row.id, db, MORNING + 1000);

      const day = waterDay(USER, asLocalDay('2026-06-15'), db);
      expect(day.consumedMl).toBe(500);
      expect(day.entryCount).toBe(1);
      expect(listWaterDay(USER, asLocalDay('2026-06-15'), db)).toHaveLength(1);
    });

    it('records the deletion as a fact to be synchronised', () => {
      const row = drink(250);
      deleteWaterLog(row.id, db, MORNING + 1000);

      const operations = db
        .all<{ operation: string }>(
          'SELECT operation FROM sync_outbox WHERE row_id = ? ORDER BY id',
          [row.id],
        )
        .map((entry) => entry.operation);

      expect(operations).toEqual(['upsert', 'delete']);
      expect(
        db.get<{ deleted_at: number }>('SELECT deleted_at FROM water_logs WHERE id = ?', [
          row.id,
        ])?.deleted_at,
      ).toBe(MORNING + 1000);
    });
  });

  describe('daily totals', () => {
    it('sums the day and counts the entries', () => {
      drink(250);
      drink(500, MORNING + 3_600_000);
      drink(1000, MORNING + 7_200_000);

      const day = waterDay(USER, asLocalDay('2026-06-15'), db);
      expect(day.consumedMl).toBe(1750);
      expect(day.entryCount).toBe(3);
    });

    it('is zero for a day with nothing in it', () => {
      const day = waterDay(USER, asLocalDay('2026-06-14'), db);
      expect(day.consumedMl).toBe(0);
      expect(day.entryCount).toBe(0);
      expect(day.progress).toBeNull();
    });

    it('never counts another user toward this one', () => {
      drink(250);
      logWater(
        { userId: OTHER, amountMl: 3000, timeZone: ZURICH, at: MORNING },
        db,
      );

      expect(waterDay(USER, asLocalDay('2026-06-15'), db).consumedMl).toBe(250);
    });

    it('equals the sum of the entries it lists', () => {
      const amounts = [250, 500, 125, 750, 300];
      for (const ml of amounts) drink(ml);

      const listed = listWaterDay(USER, asLocalDay('2026-06-15'), db);
      const day = waterDay(USER, asLocalDay('2026-06-15'), db);

      expect(day.consumedMl).toBe(listed.reduce((sum, row) => sum + row.amount_ml, 0));
      expect(day.consumedMl).toBe(amounts.reduce((sum, ml) => sum + ml, 0));
    });
  });
});

describe('water goals', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  const open = (from: string, targetMl: number, at: number, extra = {}) =>
    openWaterGoal(
      { userId: USER, effectiveFrom: asLocalDay(from), targetMl, at, ...extra },
      db,
    );

  it('resolves a date to the goal that was in force then', () => {
    open('2026-08-01', 2400, 1000);
    open('2026-08-11', 2800, 2000);

    expect(waterGoalForDate(USER, asLocalDay('2026-08-05'), db)?.target_ml).toBe(2400);
    expect(waterGoalForDate(USER, asLocalDay('2026-08-15'), db)?.target_ml).toBe(2800);
  });

  it.each([
    ['2026-08-01', 2400],
    ['2026-08-10', 2400],
    ['2026-08-11', 2800],
  ])('resolves the boundary date %s to %s', (day, expected) => {
    open('2026-08-01', 2400, 1000);
    open('2026-08-11', 2800, 2000);
    expect(waterGoalForDate(USER, asLocalDay(day), db)?.target_ml).toBe(expected);
  });

  it('has no goal before the first period', () => {
    open('2026-08-01', 2400, 1000);
    expect(waterGoalForDate(USER, asLocalDay('2026-07-31'), db)).toBeUndefined();
  });

  it('closes the earlier period the day before the next starts', () => {
    open('2026-08-01', 2400, 1000);
    open('2026-08-11', 2800, 2000);

    const [newest, oldest] = listWaterGoalPeriods(USER, db);
    expect(newest!.effective_to).toBeNull();
    expect(oldest!.effective_to).toBe('2026-08-10');
  });

  it('keeps the recommendation beside a manual target', () => {
    const goal = open('2026-08-01', 2800, 1000, {
      recommendedMl: 2400,
      basisWeightKg: 68.5,
    });

    expect(goal.target_ml).toBe(2800);
    expect(goal.calculated_ml).toBe(2400);
    expect(goal.source).toBe('manual');
  });

  it('records an accepted recommendation as calculated', () => {
    const goal = open('2026-08-01', 2400, 1000, {
      recommendedMl: 2400,
      basisWeightKg: 68.5,
    });

    expect(goal.source).toBe('calculated');
    expect(goal.calculated_ml).toBe(2400);
  });

  it('records a target with no suggestion behind it as manual', () => {
    const goal = open('2026-08-01', 3000, 1000);

    expect(goal.source).toBe('manual');
    expect(goal.calculated_ml).toBeNull();
  });

  /**
   * The recommendation depends on weight, so this is the moment a naive
   * design would re-derive every past goal.
   */
  it('does not rewrite an earlier goal when a new one opens', () => {
    const august = open('2026-08-01', 2400, 1000, { basisWeightKg: 68.5 });
    const read = () =>
      db.get<Record<string, unknown>>('SELECT * FROM water_goals WHERE id = ?', [
        august.id,
      ])!;
    const before = read();

    // The user gains 14 kg and recalculates. The recommendation depends on
    // weight, so this is precisely where a naive design would re-derive.
    open('2026-09-01', 2900, 2000, { basisWeightKg: 82 });

    const after = read();

    /*
     * `effective_to` is the one column that must move: it is derived from the
     * next period's start, and a new September period is exactly what changes
     * where August ends. Everything else — the target, the recommendation, the
     * weight it was computed from — is a stored fact and must not.
     */
    expect(after.effective_to).toBe('2026-08-31');
    expect(before.effective_to).toBeNull();

    const { effective_to: _movedAfter, ...restAfter } = after;
    const { effective_to: _movedBefore, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);

    expect(waterGoalForDate(USER, asLocalDay('2026-08-05'), db)?.target_ml).toBe(2400);
    expect(waterGoalForDate(USER, asLocalDay('2026-08-05'), db)?.basis_weight_kg).toBe(68.5);
  });

  it('puts the later of two same-day periods in force', () => {
    const first = open('2026-08-01', 2000, 1000);
    const second = open('2026-08-01', 2600, 2000);

    expect(waterGoalForDate(USER, asLocalDay('2026-08-01'), db)?.id).toBe(second.id);
    expect(
      db.get<{ effective_to: string }>(
        'SELECT effective_to FROM water_goals WHERE id = ?',
        [first.id],
      )?.effective_to,
    ).toBe('2026-07-31');
  });

  it('falls dates back to the previous period when one is removed', () => {
    open('2026-08-01', 2400, 1000);
    const middle = open('2026-08-11', 2800, 2000);
    open('2026-09-01', 3000, 3000);

    deleteWaterGoal(middle.id, db, 4000);

    expect(waterGoalForDate(USER, asLocalDay('2026-08-15'), db)?.target_ml).toBe(2400);
    expect(waterGoalForDate(USER, asLocalDay('2026-09-15'), db)?.target_ml).toBe(3000);
  });

  it('never reads another user goal', () => {
    open('2026-08-01', 2400, 1000);
    openWaterGoal(
      { userId: OTHER, effectiveFrom: asLocalDay('2026-08-01'), targetMl: 9000, at: 1500 },
      db,
    );

    expect(waterGoalForDate(USER, asLocalDay('2026-08-05'), db)?.target_ml).toBe(2400);
    expect(waterGoalForDate(OTHER, asLocalDay('2026-08-05'), db)?.target_ml).toBe(9000);
  });
});

describe('water against its own day goal', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);

    openWaterGoal(
      { userId: USER, effectiveFrom: asLocalDay('2026-08-01'), targetMl: 2000, at: 1000 },
      db,
    );
    openWaterGoal(
      { userId: USER, effectiveFrom: asLocalDay('2026-08-11'), targetMl: 2500, at: 2000 },
      db,
    );
  });

  afterEach(() => db.close());

  const drinkOn = (day: string, ml: number, at: number) =>
    logWater(
      {
        userId: USER,
        amountMl: ml,
        timeZone: ZURICH,
        localDate: asLocalDay(day),
        at,
      },
      db,
    );

  it('measures an old day against the target that applied then', () => {
    drinkOn('2026-08-05', 1750, 10_000);

    const day = waterDay(USER, asLocalDay('2026-08-05'), db);
    expect(day.targetMl).toBe(2000);
    expect(day.progress?.remaining).toBe(250);
    expect(day.progress?.isOver).toBe(false);
  });

  it('measures a newer day against the newer target', () => {
    drinkOn('2026-08-15', 1750, 11_000);

    const day = waterDay(USER, asLocalDay('2026-08-15'), db);
    expect(day.targetMl).toBe(2500);
    expect(day.progress?.remaining).toBe(750);
  });

  /**
   * The same intake either side of a goal change: one meets the target and one
   * does not. A history using today's goal for both would call them identical.
   */
  it('gives the same intake different verdicts across a goal change', () => {
    drinkOn('2026-08-05', 2200, 10_000);
    drinkOn('2026-08-15', 2200, 11_000);

    expect(waterDay(USER, asLocalDay('2026-08-05'), db).progress?.isOver).toBe(true);
    expect(waterDay(USER, asLocalDay('2026-08-15'), db).progress?.isOver).toBe(false);
  });

  it('does not re-measure a historical day when a new goal opens today', () => {
    drinkOn('2026-08-05', 1750, 10_000);
    const before = waterDay(USER, asLocalDay('2026-08-05'), db).targetMl;

    openWaterGoal(
      { userId: USER, effectiveFrom: asLocalDay('2026-09-01'), targetMl: 3500, at: 20_000 },
      db,
    );

    expect(waterDay(USER, asLocalDay('2026-08-05'), db).targetMl).toBe(before);
    expect(before).toBe(2000);
  });

  describe('history', () => {
    it('returns every day in the range, including blank ones', () => {
      drinkOn('2026-08-05', 1750, 10_000);

      const days = waterHistory(
        USER,
        { from: asLocalDay('2026-08-03'), to: asLocalDay('2026-08-07') },
        db,
      );

      expect(days.map((day) => day.day)).toEqual([
        '2026-08-03',
        '2026-08-04',
        '2026-08-05',
        '2026-08-06',
        '2026-08-07',
      ]);
      expect(days[2]!.consumedMl).toBe(1750);
      expect(days[0]!.consumedMl).toBe(0);
      expect(days[0]!.entryCount).toBe(0);
    });

    it('attaches each day to its own goal across a change', () => {
      const days = waterHistory(
        USER,
        { from: asLocalDay('2026-08-09'), to: asLocalDay('2026-08-12') },
        db,
      );

      expect(days.map((day) => day.targetMl)).toEqual([2000, 2000, 2500, 2500]);
    });

    it('has no target for days before the first goal period', () => {
      const days = waterHistory(
        USER,
        { from: asLocalDay('2026-07-30'), to: asLocalDay('2026-08-02') },
        db,
      );

      expect(days.map((day) => day.targetMl)).toEqual([null, null, 2000, 2000]);
      expect(days[0]!.progress).toBeNull();
    });

    it('excludes deleted entries from history as well as from today', () => {
      const row = drinkOn('2026-08-05', 1750, 10_000);
      deleteWaterLog(row.id, db, 12_000);

      const days = waterHistory(
        USER,
        { from: asLocalDay('2026-08-05'), to: asLocalDay('2026-08-05') },
        db,
      );
      expect(days[0]!.consumedMl).toBe(0);
    });
  });

  describe('summary', () => {
    it('averages over the range, not over the days logged', () => {
      drinkOn('2026-08-11', 2000, 10_000);
      drinkOn('2026-08-12', 3000, 11_000);

      const days = waterHistory(
        USER,
        { from: asLocalDay('2026-08-11'), to: asLocalDay('2026-08-17') },
        db,
      );
      const summary = summariseWater(days);

      expect(summary.daysInRange).toBe(7);
      expect(summary.daysLogged).toBe(2);
      expect(summary.totalMl).toBe(5000);
      // 5,000 over seven days, not over the two that were logged.
      expect(summary.averageMl).toBe(Math.round(5000 / 7));
    });

    it('counts the days the goal was actually met', () => {
      drinkOn('2026-08-11', 2500, 10_000);
      drinkOn('2026-08-12', 2600, 11_000);
      drinkOn('2026-08-13', 1000, 12_000);

      const summary = summariseWater(
        waterHistory(
          USER,
          { from: asLocalDay('2026-08-11'), to: asLocalDay('2026-08-13') },
          db,
        ),
      );

      expect(summary.daysGoalMet).toBe(2);
      expect(summary.daysLogged).toBe(3);
    });

    it('is empty rather than undefined for a range with nothing in it', () => {
      const summary = summariseWater(
        waterHistory(
          USER,
          { from: addDays(asLocalDay('2026-08-01'), -30), to: asLocalDay('2026-07-31') },
          db,
        ),
      );

      expect(summary.daysLogged).toBe(0);
      expect(summary.averageMl).toBe(0);
      expect(summary.totalMl).toBe(0);
    });
  });
});
