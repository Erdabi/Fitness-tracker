import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import type { SqlDatabase } from '@/db/types';
import { addDays, asLocalDay } from '@/lib/date';
import { calculateTargets, type BodyMetrics } from '@/lib/energy';
import {
  currentGoal,
  deleteGoalPeriod,
  deriveSource,
  editGoalPeriod,
  goalForDate,
  isBelowFloor,
  listGoalPeriods,
  openCalculatedGoal,
  openGoalPeriod,
  resyncGoalPeriods,
  type GoalBasis,
} from '../goals';

/**
 * Goal periods.
 *
 * The property under test throughout is that the past does not move. Every
 * assertion about history is made by changing something — the profile, the
 * target, the periods around it — and then reading an old date back.
 */

const USER = 'user-alice';
const OTHER = 'user-bob';

const BASIS: GoalBasis = {
  bmr: 1780,
  tdee: 2759,
  activity: 'moderate',
  direction: 'lose',
  weightKg: 80,
  heightCm: 180,
  ageYears: 30,
  sex: 'male',
};

const MACROS = { protein_g: 144, carbohydrates_g: 200, fat_g: 63 };

function open(
  db: SqlDatabase,
  from: string,
  calories: number,
  overrides: Parameters<typeof openGoalPeriod>[0] extends infer T
    ? Partial<Omit<T, 'userId' | 'effectiveFrom'>>
    : never = {},
) {
  return openGoalPeriod(
    {
      userId: USER,
      effectiveFrom: asLocalDay(from),
      targets: { calorieTarget: calories, macros: MACROS },
      recommendation: { calorieTarget: calories, macros: MACROS },
      basis: BASIS,
      ...overrides,
    },
    db,
  );
}

describe('goal periods', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  describe('history', () => {
    beforeEach(() => {
      open(db, '2026-08-01', 2000, { at: 1000 });
      open(db, '2026-08-11', 2200, { at: 2000 });
    });

    /** The example from the specification, exactly. */
    it('resolves a diary date to the goal that was in force then', () => {
      expect(goalForDate(USER, asLocalDay('2026-08-05'), db)?.calorie_target).toBe(2000);
      expect(goalForDate(USER, asLocalDay('2026-08-15'), db)?.calorie_target).toBe(2200);
    });

    it.each([
      ['2026-08-01', 2000, 'the first day of a period is inside it'],
      ['2026-08-10', 2000, 'the last day of a period is inside it'],
      ['2026-08-11', 2200, 'the next period starts on its own first day'],
    ])('resolves %s to %s — %s', (day, expected) => {
      expect(goalForDate(USER, asLocalDay(day), db)?.calorie_target).toBe(expected);
    });

    it('has no goal for a date before any period began', () => {
      expect(goalForDate(USER, asLocalDay('2026-07-31'), db)).toBeUndefined();
    });

    it('extends the open period indefinitely forward', () => {
      expect(goalForDate(USER, asLocalDay('2031-01-01'), db)?.calorie_target).toBe(2200);
    });

    it('closes the earlier period the day before the next one starts', () => {
      const [newest, oldest] = listGoalPeriods(USER, db);

      expect(newest!.effective_from).toBe('2026-08-11');
      expect(newest!.effective_to).toBeNull();
      expect(oldest!.effective_from).toBe('2026-08-01');
      expect(oldest!.effective_to).toBe('2026-08-10');
    });

    it('never lets two live periods cover the same day', () => {
      open(db, '2026-08-20', 2300, { at: 3000 });
      open(db, '2026-09-01', 2400, { at: 4000 });

      for (let offset = 0; offset <= 80; offset += 1) {
        const probe = addDays(asLocalDay('2026-07-25'), offset);
        const covering = db.all(
          `SELECT id FROM nutrition_goals
            WHERE user_id = ? AND deleted_at IS NULL AND effective_from <= ?
              AND (effective_to IS NULL OR effective_to >= ?)`,
          [USER, probe, probe],
        );
        expect(covering.length).toBeLessThanOrEqual(1);
      }
    });

    it('slots a backfilled period between two that already exist', () => {
      open(db, '2026-09-01', 2400, { at: 3000 });
      const gap = open(db, '2026-08-20', 2300, { at: 4000 });

      expect(goalForDate(USER, asLocalDay('2026-08-15'), db)?.calorie_target).toBe(2200);
      expect(goalForDate(USER, asLocalDay('2026-08-25'), db)?.calorie_target).toBe(2300);
      expect(goalForDate(USER, asLocalDay('2026-09-15'), db)?.calorie_target).toBe(2400);

      const stored = db.get<{ effective_to: string }>(
        'SELECT effective_to FROM nutrition_goals WHERE id = ?',
        [gap.id],
      );
      expect(stored?.effective_to).toBe('2026-08-31');
    });

    /**
     * The whole point of periods: opening a new one is not an edit. If it
     * were, every past diary day would silently re-read.
     */
    it('leaves every earlier period untouched when a new one opens', () => {
      const before = db.all<Record<string, unknown>>(
        'SELECT * FROM nutrition_goals WHERE effective_from = ?',
        ['2026-08-01'],
      );

      open(db, '2026-09-01', 2400, { at: 5000 });

      const after = db.all<Record<string, unknown>>(
        'SELECT * FROM nutrition_goals WHERE effective_from = ?',
        ['2026-08-01'],
      );
      expect(after).toEqual(before);
    });

    it('never reads another user goals', () => {
      openGoalPeriod(
        {
          userId: OTHER,
          effectiveFrom: asLocalDay('2026-08-05'),
          targets: { calorieTarget: 9999, macros: MACROS },
          recommendation: null,
          at: 6000,
        },
        db,
      );

      expect(goalForDate(USER, asLocalDay('2026-08-05'), db)?.calorie_target).toBe(2000);
      expect(goalForDate(OTHER, asLocalDay('2026-08-05'), db)?.calorie_target).toBe(9999);
    });
  });

  describe('two periods opened on the same day', () => {
    it('puts the later one in force and marks the earlier as superseded', () => {
      const first = open(db, '2026-08-01', 1900, { at: 1000 });
      const second = open(db, '2026-08-01', 2100, { at: 2000 });

      expect(goalForDate(USER, asLocalDay('2026-08-01'), db)?.id).toBe(second.id);

      const superseded = db.get<{ effective_to: string }>(
        'SELECT effective_to FROM nutrition_goals WHERE id = ?',
        [first.id],
      );
      // Ends the day before it started: an empty range, covering nothing.
      expect(superseded?.effective_to).toBe('2026-07-31');
    });

    it('keeps the superseded row, because it is still a record of a choice', () => {
      open(db, '2026-08-01', 1900, { at: 1000 });
      open(db, '2026-08-01', 2100, { at: 2000 });

      expect(
        db.get<{ count: number }>('SELECT COUNT(*) AS count FROM nutrition_goals')?.count,
      ).toBe(2);
    });
  });

  describe('the recommendation is preserved', () => {
    /** The example from the specification: suggested 2,050, chose 2,200. */
    it('stores both the suggestion and the target the user picked', () => {
      const goal = openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-08-01'),
          targets: { calorieTarget: 2200, macros: MACROS },
          recommendation: { calorieTarget: 2050, macros: MACROS },
          basis: BASIS,
          at: 1000,
        },
        db,
      );

      expect(goal.calorie_target).toBe(2200);
      expect(goal.calculated_calories).toBe(2050);
      expect(goal.source).toBe('calculated_then_modified');
    });

    it('records an accepted recommendation as calculated', () => {
      const calculated = calculateTargets(
        { weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male' } as BodyMetrics,
        'moderate',
        'lose',
      )!;

      const goal = openCalculatedGoal(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-08-01'),
          calculated,
          basis: BASIS,
          at: 1000,
        },
        db,
      );

      expect(goal.source).toBe('calculated');
      expect(goal.calculated_calories).toBe(goal.calorie_target);
      expect(goal.basis_bmr).toBe(1780);
      expect(goal.basis_tdee).toBe(2759);
    });

    it('records a target with no suggestion behind it as manual', () => {
      const goal = openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-08-01'),
          targets: { calorieTarget: 2500, macros: MACROS },
          recommendation: null,
          at: 1000,
        },
        db,
      );

      expect(goal.source).toBe('manual');
      expect(goal.calculated_calories).toBeNull();
      expect(goal.basis_bmr).toBeNull();
    });

    it('treats a macro-only change as a modification', () => {
      const goal = openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-08-01'),
          targets: { calorieTarget: 2000, macros: { ...MACROS, protein_g: 170 } },
          recommendation: { calorieTarget: 2000, macros: MACROS },
          basis: BASIS,
          at: 1000,
        },
        db,
      );

      expect(goal.source).toBe('calculated_then_modified');
      expect(goal.protein_target_g).toBe(170);
      expect(goal.calculated_protein_g).toBe(144);
    });

    it('derives the source from the numbers, not from the caller', () => {
      const targets = { calorieTarget: 2000, macros: MACROS };
      expect(deriveSource(targets, null)).toBe('manual');
      expect(deriveSource(targets, targets)).toBe('calculated');
      expect(deriveSource(targets, { calorieTarget: 2050, macros: MACROS })).toBe(
        'calculated_then_modified',
      );
    });

    it('keeps the suggestion when the target is edited afterwards', () => {
      const goal = open(db, '2026-08-01', 2050, { at: 1000 });

      const edited = editGoalPeriod(
        goal.id,
        { targets: { calorieTarget: 2200, macros: MACROS }, at: 2000 },
        db,
      );

      expect(edited.calorie_target).toBe(2200);
      expect(edited.calculated_calories).toBe(2050);
      expect(edited.source).toBe('calculated_then_modified');
      expect(edited.basis_bmr).toBe(1780);
    });
  });

  describe('the basis is snapshotted', () => {
    /**
     * A recalculation opens a new period. It must not reach backwards — a goal
     * from August is a stored fact, not a function of who the user is now.
     */
    it('does not rewrite an old goal when the body metrics change', () => {
      const august = open(db, '2026-08-01', 2000, { at: 1000 });

      open(db, '2026-09-01', 2400, {
        at: 2000,
        basis: { ...BASIS, weightKg: 95, activity: 'very' },
      });

      const stored = db.get<{
        basis_weight_kg: number;
        basis_activity: string;
        calorie_target: number;
      }>(
        'SELECT basis_weight_kg, basis_activity, calorie_target FROM nutrition_goals WHERE id = ?',
        [august.id],
      );

      expect(stored).toEqual({
        basis_weight_kg: 80,
        basis_activity: 'moderate',
        calorie_target: 2000,
      });
    });

    it('explains a historical goal without consulting the profile', () => {
      const goal = open(db, '2026-08-01', 2000, { at: 1000 });

      expect(goal.basis_bmr).toBe(1780);
      expect(goal.basis_height_cm).toBe(180);
      expect(goal.basis_age_years).toBe(30);
      expect(goal.basis_sex).toBe('male');
      expect(goal.basis_direction).toBe('lose');
    });
  });

  describe('removing a period', () => {
    it('falls the dates back to the period before it', () => {
      open(db, '2026-08-01', 2000, { at: 1000 });
      const middle = open(db, '2026-08-11', 2200, { at: 2000 });
      open(db, '2026-09-01', 2400, { at: 3000 });

      deleteGoalPeriod(middle.id, db, 4000);

      expect(goalForDate(USER, asLocalDay('2026-08-15'), db)?.calorie_target).toBe(2000);
      expect(goalForDate(USER, asLocalDay('2026-09-15'), db)?.calorie_target).toBe(2400);
    });

    it('soft-deletes, so the removal can be synchronised', () => {
      const goal = open(db, '2026-08-01', 2000, { at: 1000 });
      deleteGoalPeriod(goal.id, db, 2000);

      const stored = db.get<{ deleted_at: number | null }>(
        'SELECT deleted_at FROM nutrition_goals WHERE id = ?',
        [goal.id],
      );
      expect(stored?.deleted_at).toBe(2000);

      const operations = db
        .all<{ operation: string }>(
          'SELECT operation FROM sync_outbox WHERE row_id = ? ORDER BY id',
          [goal.id],
        )
        .map((entry) => entry.operation);
      expect(operations).toEqual(['upsert', 'delete']);
    });
  });

  describe('resyncGoalPeriods', () => {
    /**
     * The derived column is recomputed locally rather than pushed, so a change
     * of target is exactly one row to send. This asserts the recomputation is
     * a pure function of the periods — running it twice changes nothing.
     */
    it('is idempotent', () => {
      open(db, '2026-08-01', 2000, { at: 1000 });
      open(db, '2026-08-11', 2200, { at: 2000 });

      const before = db.all('SELECT id, effective_to FROM nutrition_goals ORDER BY id');
      resyncGoalPeriods(USER, db);
      resyncGoalPeriods(USER, db);
      const after = db.all('SELECT id, effective_to FROM nutrition_goals ORDER BY id');

      expect(after).toEqual(before);
    });

    it('does not queue the derived column for sync', () => {
      open(db, '2026-08-01', 2000, { at: 1000 });
      open(db, '2026-08-11', 2200, { at: 2000 });

      // Two goals, two outbox entries. The recomputation that closed the first
      // period added none of its own.
      expect(
        db.get<{ count: number }>('SELECT COUNT(*) AS count FROM sync_outbox')?.count,
      ).toBe(2);
    });

    it('does not make a local recomputation look like a user edit', () => {
      const first = open(db, '2026-08-01', 2000, { at: 1000 });
      open(db, '2026-08-11', 2200, { at: 2000 });

      const stored = db.get<{ updated_at: number }>(
        'SELECT updated_at FROM nutrition_goals WHERE id = ?',
        [first.id],
      );
      // Still the moment it was written, not the moment it was closed.
      expect(stored?.updated_at).toBe(1000);
    });
  });

  describe('currentGoal', () => {
    it('is the period covering today', () => {
      open(db, '2026-08-01', 2000, { at: 1000 });
      open(db, '2026-08-11', 2200, { at: 2000 });

      expect(currentGoal(USER, asLocalDay('2026-08-20'), db)?.calorie_target).toBe(2200);
    });

    it('is absent before the user has ever set one', () => {
      expect(currentGoal(USER, asLocalDay('2026-08-20'), db)).toBeUndefined();
    });
  });

  describe('isBelowFloor', () => {
    it('uses the same figures the calculator floors with', () => {
      expect(isBelowFloor(1100, 'female', null)).toBe(true);
      expect(isBelowFloor(1300, 'female', null)).toBe(false);
      expect(isBelowFloor(1300, 'male', null)).toBe(true);
    });

    it('takes the person own resting rate when that is higher', () => {
      expect(isBelowFloor(1700, 'male', 1800)).toBe(true);
      expect(isBelowFloor(1900, 'male', 1800)).toBe(false);
    });

    it('treats an unrecorded sex as the lower of the two table figures', () => {
      expect(isBelowFloor(1100, null, null)).toBe(true);
      expect(isBelowFloor(1300, 'other', null)).toBe(false);
    });
  });
});
