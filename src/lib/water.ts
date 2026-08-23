import { goalProgress, type GoalProgress } from './energy';
import { formatVolume, mlToFlOz, round, type UnitSystem } from './units';

/**
 * Water arithmetic.
 *
 * Deliberately thin. Progress against a target is the same problem the calorie
 * goal already solved, so `waterProgress` delegates to `goalProgress` rather
 * than reimplementing "remaining, and never a negative allowance"; display
 * delegates to `formatVolume`. What is genuinely new here is the daily
 * recommendation and the quick-add amounts.
 *
 * Storage is millilitres, always. A column holding both ml and fluid ounces
 * cannot be repaired afterwards, so the unit a user reads is a display
 * preference and nothing else.
 */

/**
 * The quick-add amounts on the dashboard.
 *
 * Sized to real containers rather than to round numbers for their own sake: a
 * glass, a large glass, a small bottle, a litre bottle. Every one of them goes
 * through the same logging service — there is no per-button logic anywhere.
 */
export const QUICK_ADD_ML: readonly number[] = [250, 500, 750, 1000];

/** Bounds on a single entry. The upper one is a slipped-decimal guard. */
export const MIN_ENTRY_ML = 1;
export const MAX_ENTRY_ML = 5000;

/** Bounds on a daily target, matching the database constraint. */
export const MIN_TARGET_ML = 500;
export const MAX_TARGET_ML = 10_000;

/**
 * Millilitres of water per kilogram of body weight, per day.
 *
 * ── A product heuristic, not medical advice. ────────────────────────────────
 *
 * There is no single correct number: real requirements move with climate,
 * activity, diet and health, and none of that is in this app. 35 ml/kg is the
 * common consumer-software convention and gives a plausible starting point for
 * an adult — roughly 2.4 L at 70 kg. It is here as one named constant so that
 * changing it later is a one-line decision rather than an archaeology project,
 * and so the app never implies more precision than it has.
 *
 * The user can override the result outright, and the UI says it is a
 * suggestion wherever it appears.
 */
export const ML_PER_KG_PER_DAY = 35;

/** The recommendation is clamped to this range, whatever the arithmetic says. */
export const RECOMMENDATION_RANGE = { min: 1500, max: 4000 } as const;

/** Recommendations round to this, because 2,447 ml implies precision it lacks. */
export const RECOMMENDATION_STEP_ML = 50;

/**
 * A suggested daily target, from body weight.
 *
 * Deterministic and total: the same weight always gives the same number, and
 * an unknown weight gives the midpoint of the range rather than nothing, so
 * the dashboard can always offer a starting target.
 */
export function recommendedWaterMl(weightKg: number | null): number {
  if (weightKg === null || !Number.isFinite(weightKg) || weightKg <= 0) {
    return DEFAULT_TARGET_ML;
  }

  const raw = weightKg * ML_PER_KG_PER_DAY;
  const clamped = Math.min(
    RECOMMENDATION_RANGE.max,
    Math.max(RECOMMENDATION_RANGE.min, raw),
  );

  return Math.round(clamped / RECOMMENDATION_STEP_ML) * RECOMMENDATION_STEP_ML;
}

/**
 * What to suggest when nothing is known about the user yet.
 *
 * The recommendation at roughly average adult weight, which is the least
 * misleading thing to offer before someone has recorded one.
 */
export const DEFAULT_TARGET_ML = 2000;

/**
 * Progress against a daily target.
 *
 * `goalProgress` already distinguishes "remaining" from "over by", which is
 * the distinction that matters: rendering −300 under a label reading
 * *remaining* tells a user they have 300 ml of allowance left when in fact
 * they are 300 ml past the target.
 */
export function waterProgress(consumedMl: number, targetMl: number): GoalProgress {
  return goalProgress(consumedMl, targetMl);
}

/* ------------------------------------------------------------------ display */

/**
 * A volume, in the unit the user reads.
 *
 * Metric switches to litres at a litre, because "1750 ml" is how a database
 * stores it and "1.75 L" is how a person says it. Imperial uses fluid ounces
 * throughout, since US customary has no everyday larger unit for drinking
 * water — a "quart of water" is not how anyone describes their day.
 */
export function formatWater(ml: number, system: UnitSystem): string {
  return formatVolume(ml, system);
}

/** Always litres, for the headline figure where the unit is already stated. */
export function formatLitres(ml: number): string {
  return `${round(ml / 1000, 2)}`;
}

/** Fluid ounces, for imperial display. */
export function formatFlOz(ml: number): string {
  return `${round(mlToFlOz(ml))}`;
}

/**
 * "1.75 / 2.50 L" or "59 / 85 fl oz".
 *
 * Built here rather than at each call site so consumed and target are always
 * shown in the same unit — a pair rendered in two different units is worse
 * than either alone.
 */
export function formatWaterAgainstTarget(
  consumedMl: number,
  targetMl: number,
  system: UnitSystem,
): string {
  if (system === 'imperial') {
    return `${formatFlOz(consumedMl)} / ${formatFlOz(targetMl)} fl oz`;
  }

  // Below a litre on both sides, millilitres read better than "0.25 / 0.50 L".
  if (consumedMl < 1000 && targetMl < 1000) {
    return `${Math.round(consumedMl)} / ${Math.round(targetMl)} ml`;
  }

  return `${formatLitres(consumedMl)} / ${formatLitres(targetMl)} L`;
}

/**
 * "750 ml remaining" or "+300 ml over goal".
 *
 * One function so the two cases cannot be worded inconsistently, and so the
 * over case is never expressed as a negative remainder.
 */
export function describeWaterProgress(
  progress: GoalProgress,
  system: UnitSystem,
): string {
  return progress.isOver
    ? `+${formatWater(progress.overBy, system)} over goal`
    : `${formatWater(progress.remaining, system)} remaining`;
}
