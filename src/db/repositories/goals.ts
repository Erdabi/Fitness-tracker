import { getDatabase } from '../client';
import type {
  ActivityLevelValue,
  GoalDirectionValue,
  GoalSource,
  NutritionGoalRow,
  Sex,
} from '../schema';
import type { SqlDatabase } from '../types';
import { addDays, asLocalDay, type LocalDay } from '@/lib/date';
import {
  calorieFloorFor,
  type CalculatedTargets,
  type MacroTargets,
} from '@/lib/energy';
import { newId } from '@/lib/id';
import { withOutbox } from '@/sync/outbox';

/**
 * Goal periods.
 *
 * A goal is a period, not a setting. Changing a target opens a new period and
 * leaves every previous one exactly as it was — which is what lets the diary
 * for 5 August show the target that was in force on 5 August rather than the
 * one in force today.
 *
 * Two rules run through everything here:
 *
 *   • A historical goal is a STORED FACT. Nothing recomputes it from the
 *     current profile. Changing weight, height, age or activity has no effect
 *     on any goal that already exists.
 *
 *   • The RECOMMENDATION IS KEPT beside the target. When someone overrides a
 *     suggested 2,050 with 2,200, both are stored, because otherwise there is
 *     no way to say later what the app had actually proposed.
 */

export interface GoalTargets {
  readonly calorieTarget: number;
  readonly macros: MacroTargets;
}

export interface GoalBasis {
  readonly bmr: number;
  readonly tdee: number;
  readonly activity: ActivityLevelValue;
  readonly direction: GoalDirectionValue;
  readonly weightKg: number;
  readonly heightCm: number | null;
  readonly ageYears: number | null;
  readonly sex: Sex;
}

export interface OpenGoalInput {
  readonly userId: string;
  /** The day the period starts. Defaults to today in the caller's zone. */
  readonly effectiveFrom: LocalDay;
  /** What the diary will compare against. */
  readonly targets: GoalTargets;
  /** What the app recommended, when it recommended anything. */
  readonly recommendation?: GoalTargets | null;
  readonly basis?: GoalBasis | null;
  /** Set when the user knowingly chose a target below the floor. */
  readonly acknowledgedBelowFloor?: boolean;
  readonly note?: string | null;
  /** Epoch ms, for tests. */
  readonly at?: number;
}

/**
 * Opens a goal period.
 *
 * Deliberately not "update the goal". The previous period is not edited and
 * not deleted; it simply stops being the latest, and `resyncGoalPeriods`
 * closes it the day before this one starts.
 *
 * `source` is derived rather than passed in, so it cannot disagree with the
 * numbers beside it: a target that matches its recommendation is `calculated`,
 * one that differs is `calculated_then_modified`, and one with no
 * recommendation at all is `manual`. The database enforces the same three
 * rules, and a row that broke them would be rejected on push.
 */
export function openGoalPeriod(
  input: OpenGoalInput,
  db: SqlDatabase = getDatabase(),
): NutritionGoalRow {
  const now = input.at ?? Date.now();
  const recommendation = input.recommendation ?? null;

  const row: NutritionGoalRow = {
    id: newId(),
    user_id: input.userId,

    effective_from: input.effectiveFrom,
    // Derived below, once this row is in place.
    effective_to: null,

    calorie_target: input.targets.calorieTarget,
    protein_target_g: input.targets.macros.protein_g,
    carbohydrate_target_g: input.targets.macros.carbohydrates_g,
    fat_target_g: input.targets.macros.fat_g,

    source: deriveSource(input.targets, recommendation),

    calculated_calories: recommendation?.calorieTarget ?? null,
    calculated_protein_g: recommendation?.macros.protein_g ?? null,
    calculated_carbohydrate_g: recommendation?.macros.carbohydrates_g ?? null,
    calculated_fat_g: recommendation?.macros.fat_g ?? null,

    basis_bmr: input.basis ? Math.round(input.basis.bmr) : null,
    basis_tdee: input.basis ? Math.round(input.basis.tdee) : null,
    basis_activity: input.basis?.activity ?? null,
    basis_direction: input.basis?.direction ?? null,
    basis_weight_kg: input.basis?.weightKg ?? null,
    basis_height_cm: input.basis?.heightCm ?? null,
    basis_age_years: input.basis?.ageYears ?? null,
    basis_sex: input.basis?.sex ?? null,

    acknowledged_below_floor: input.acknowledgedBelowFloor ? 1 : 0,
    note: input.note ?? null,

    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  withOutbox(db, { table: 'nutrition_goals', rowId: row.id, operation: 'upsert' }, () => {
    insertRow(db, row);
  });

  // Outside the outbox on purpose: see resyncGoalPeriods.
  resyncGoalPeriods(input.userId, db);

  return { ...row, effective_to: readEffectiveTo(db, row.id) };
}

/**
 * Which of the three sources this pairing represents.
 *
 * Derived from the numbers rather than declared by the caller, because a
 * caller that says "calculated" while holding a different target has produced
 * a row nobody can interpret — and the database rejects exactly that.
 */
export function deriveSource(
  targets: GoalTargets,
  recommendation: GoalTargets | null,
): GoalSource {
  if (!recommendation) return 'manual';

  const identical =
    targets.calorieTarget === recommendation.calorieTarget &&
    targets.macros.protein_g === recommendation.macros.protein_g &&
    targets.macros.carbohydrates_g === recommendation.macros.carbohydrates_g &&
    targets.macros.fat_g === recommendation.macros.fat_g;

  return identical ? 'calculated' : 'calculated_then_modified';
}

/** Opens a period straight from a calculation, accepted as offered. */
export function openCalculatedGoal(
  params: {
    userId: string;
    effectiveFrom: LocalDay;
    calculated: CalculatedTargets;
    basis: GoalBasis;
    at?: number;
  },
  db: SqlDatabase = getDatabase(),
): NutritionGoalRow {
  const targets: GoalTargets = {
    calorieTarget: params.calculated.calorieTarget,
    macros: params.calculated.macros,
  };

  return openGoalPeriod(
    {
      userId: params.userId,
      effectiveFrom: params.effectiveFrom,
      targets,
      recommendation: targets,
      basis: params.basis,
      at: params.at,
    },
    db,
  );
}

/**
 * Edits a period in place.
 *
 * For correcting a period that is already open — a typo in a manual target —
 * rather than for changing your mind about the future, which opens a new
 * period instead. The distinction matters: editing rewrites what the diary
 * shows for every day the period already covers, so it is the wrong tool for
 * "from today I want something different".
 *
 * The recommendation and the basis are never touched. If the edited target
 * moves away from the recommendation, the source follows.
 */
export function editGoalPeriod(
  id: string,
  patch: {
    targets?: GoalTargets;
    acknowledgedBelowFloor?: boolean;
    note?: string | null;
    at?: number;
  },
  db: SqlDatabase = getDatabase(),
): NutritionGoalRow {
  const existing = db.get<NutritionGoalRow>(
    'SELECT * FROM nutrition_goals WHERE id = ?',
    [id],
  );
  if (!existing) throw new Error(`Cannot edit goal ${id}: it does not exist`);

  const now = patch.at ?? Date.now();
  const targets = patch.targets ?? {
    calorieTarget: existing.calorie_target,
    macros: {
      protein_g: existing.protein_target_g,
      carbohydrates_g: existing.carbohydrate_target_g,
      fat_g: existing.fat_target_g,
    },
  };

  const recommendation: GoalTargets | null =
    existing.calculated_calories === null
      ? null
      : {
          calorieTarget: existing.calculated_calories,
          macros: {
            protein_g: existing.calculated_protein_g ?? 0,
            carbohydrates_g: existing.calculated_carbohydrate_g ?? 0,
            fat_g: existing.calculated_fat_g ?? 0,
          },
        };

  const next: NutritionGoalRow = {
    ...existing,
    calorie_target: targets.calorieTarget,
    protein_target_g: targets.macros.protein_g,
    carbohydrate_target_g: targets.macros.carbohydrates_g,
    fat_target_g: targets.macros.fat_g,
    source: deriveSource(targets, recommendation),
    acknowledged_below_floor:
      patch.acknowledgedBelowFloor === undefined
        ? existing.acknowledged_below_floor
        : patch.acknowledgedBelowFloor
          ? 1
          : 0,
    note: patch.note !== undefined ? patch.note : existing.note,
    updated_at: now,
  };

  withOutbox(db, { table: 'nutrition_goals', rowId: id, operation: 'upsert' }, () => {
    db.run(
      `UPDATE nutrition_goals SET
         calorie_target = ?, protein_target_g = ?, carbohydrate_target_g = ?,
         fat_target_g = ?, source = ?, acknowledged_below_floor = ?, note = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        next.calorie_target,
        next.protein_target_g,
        next.carbohydrate_target_g,
        next.fat_target_g,
        next.source,
        next.acknowledged_below_floor,
        next.note,
        next.updated_at,
        id,
      ],
    );
  });

  return next;
}

/**
 * Removes a goal period.
 *
 * Soft, like every other deletion in the app: a hard delete cannot be
 * synchronised, and a goal that governed a fortnight of history is a fact even
 * after the user stops wanting it. The dates it covered fall back to whichever
 * period precedes them.
 */
export function deleteGoalPeriod(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const existing = db.get<{ user_id: string }>(
    'SELECT user_id FROM nutrition_goals WHERE id = ?',
    [id],
  );
  if (!existing) return;

  withOutbox(db, { table: 'nutrition_goals', rowId: id, operation: 'delete' }, () => {
    db.run('UPDATE nutrition_goals SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  });

  resyncGoalPeriods(existing.user_id, db);
}

/* ------------------------------------------------------------------ reads */

/**
 * The goal in force on a given day.
 *
 * The latest period starting on or before the date, breaking a same-day tie by
 * creation. That ordering *is* the rule — it needs no `effective_to` to be
 * correct — which is why a period superseded before it took effect resolves
 * away naturally rather than needing to be filtered out.
 *
 * Note what this never does: consult the profile. A historical goal is stored,
 * not recomputed, and a diary date from March must not start reading
 * differently because somebody weighed themselves in December.
 */
export function goalForDate(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): NutritionGoalRow | undefined {
  return db.get<NutritionGoalRow>(
    `SELECT * FROM nutrition_goals
      WHERE user_id = ? AND deleted_at IS NULL AND effective_from <= ?
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT 1`,
    [userId, day],
  );
}

/** The period in force today, or none if the user has never set one. */
export function currentGoal(
  userId: string,
  today: LocalDay,
  db: SqlDatabase = getDatabase(),
): NutritionGoalRow | undefined {
  return goalForDate(userId, today, db);
}

/** Every period, newest first, for the history screen. */
export function listGoalPeriods(
  userId: string,
  db: SqlDatabase = getDatabase(),
  limit = 50,
): NutritionGoalRow[] {
  return db.all<NutritionGoalRow>(
    `SELECT * FROM nutrition_goals
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY effective_from DESC, created_at DESC
      LIMIT ?`,
    [userId, limit],
  );
}

/* -------------------------------------------------------- period boundaries */

/**
 * Recomputes every period's end date for one user.
 *
 * Mirrors `resync_goal_periods()` in Postgres exactly, and for the same
 * reason: `effective_to` is derived from the next period's start, so a client
 * that had to send it would need two writes to land in order — a guarantee an
 * offline outbox cannot make.
 *
 * Deliberately outside the outbox, and deliberately not touching `updated_at`.
 * The column is server-derived, the descriptor omits it on push, and bumping
 * `updated_at` here would make a purely local recomputation look like a user
 * edit to the conflict resolver.
 */
export function resyncGoalPeriods(
  userId: string,
  db: SqlDatabase = getDatabase(),
): void {
  const periods = db.all<{ id: string; effective_from: string; effective_to: string | null }>(
    `SELECT id, effective_from, effective_to FROM nutrition_goals
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY effective_from ASC, created_at ASC, id ASC`,
    [userId],
  );

  db.transaction(() => {
    periods.forEach((period, index) => {
      const next = periods[index + 1];
      const from = asLocalDay(period.effective_from);

      const effectiveTo =
        next === undefined
          ? null
          : // A same-day successor means this period never applied: it ends
            // the day before it started, an empty range covering nothing.
            next.effective_from <= period.effective_from
            ? addDays(from, -1)
            : addDays(asLocalDay(next.effective_from), -1);

      if (period.effective_to !== effectiveTo) {
        db.run('UPDATE nutrition_goals SET effective_to = ? WHERE id = ?', [
          effectiveTo,
          period.id,
        ]);
      }
    });
  });
}

function readEffectiveTo(db: SqlDatabase, id: string): string | null {
  return (
    db.get<{ effective_to: string | null }>(
      'SELECT effective_to FROM nutrition_goals WHERE id = ?',
      [id],
    )?.effective_to ?? null
  );
}

/* ---------------------------------------------------------------- helpers */

/**
 * Whether a target sits below the floor this app is willing to recommend.
 *
 * A product rule, not a medical one — see `CALORIE_FLOOR_KCAL`. Exposed here so
 * the goal screen can flag a hand-entered target using exactly the figure the
 * calculator used, rather than a second copy that drifts.
 */
export function isBelowFloor(
  calorieTarget: number,
  sex: Sex | null,
  bmr: number | null,
): boolean {
  const forEquation =
    sex === 'male' ? 'male' : sex === 'female' ? 'female' : 'unspecified';
  return calorieTarget < calorieFloorFor(forEquation, bmr);
}

function insertRow(db: SqlDatabase, row: NutritionGoalRow): void {
  const columns = Object.keys(row);
  db.run(
    `INSERT INTO nutrition_goals (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => (row as unknown as Record<string, unknown>)[column] ?? null),
  );
}
