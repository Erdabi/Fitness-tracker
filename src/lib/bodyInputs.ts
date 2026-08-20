import {
  ACTIVITY_LEVELS,
  type ActivityLevel,
  type BiologicalSex,
  type GoalDirection,
} from './energy';
import {
  cmToFeetInches,
  feetInchesToCm,
  kgToLb,
  lbToKg,
  round,
  type UnitSystem,
} from './units';

/**
 * Validation and parsing for everything the calculator asks for.
 *
 * One domain layer, shared by the calculator flow, the goal screen and the
 * repositories. Validation split across screens is validation that disagrees
 * with itself, and the disagreement always surfaces as a row the database
 * accepted and the UI cannot render.
 *
 * Two principles run through the bounds below:
 *
 *   • Reject what is not a person. The Mifflin-St Jeor regression was fitted
 *     on adults within an ordinary range; feeding it a 12 kg body mass returns
 *     a number, and that number means nothing. Refusing is more honest than
 *     rendering it.
 *
 *   • Bounds are generous. They exist to catch a slipped decimal or a pound
 *     typed into a kilogram field, not to tell anybody they are the wrong
 *     shape. Everything a real adult could plausibly be, passes.
 */

/* ------------------------------------------------------------------ bounds */

export const LIMITS = {
  /** Under-13s are outside both the regression and this app's scope. */
  ageYears: { min: 13, max: 120 },
  weightKg: { min: 25, max: 400 },
  heightCm: { min: 100, max: 250 },
  /** A manual calorie target. The lower bound is a hard input limit, not the
   *  recommendation floor — see CALORIE_FLOOR_KCAL, which is a separate rule. */
  calorieTarget: { min: 800, max: 10_000 },
  proteinG: { min: 0, max: 500 },
  carbohydratesG: { min: 0, max: 1500 },
  fatG: { min: 0, max: 500 },
} as const;

export type FieldName = keyof typeof LIMITS | 'sex' | 'activity' | 'goal';

export interface FieldError {
  readonly field: FieldName;
  readonly message: string;
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

function fail<T>(field: FieldName, message: string): Validated<T> {
  return { ok: false, errors: [{ field, message }] };
}

function inRange(
  value: number,
  bounds: { min: number; max: number },
): 'ok' | 'not-a-number' | 'low' | 'high' {
  if (!Number.isFinite(value)) return 'not-a-number';
  if (value < bounds.min) return 'low';
  if (value > bounds.max) return 'high';
  return 'ok';
}

/* ------------------------------------------------------------------ number */

/**
 * Reads a number a person typed.
 *
 * Accepts a comma as the decimal separator, because most of the world writes
 * "72,5" and a field that silently rejects it looks broken rather than strict.
 */
export function parseNumber(input: string): number | null {
  const trimmed = input.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------- mass */

/**
 * A weight, from whichever unit the user is typing in, to kilograms.
 *
 * Kilograms are stored; the entered unit is not. Keeping both would be two
 * sources of truth for one fact, and the pair drifts the first time a
 * conversion constant is touched — so the unit system is a display preference
 * and nothing else.
 */
export function validateWeight(input: string, system: UnitSystem): Validated<number> {
  const raw = parseNumber(input);
  if (raw === null) return fail('weightKg', 'Enter your weight.');

  const kg = system === 'metric' ? raw : lbToKg(raw);

  switch (inRange(kg, LIMITS.weightKg)) {
    case 'not-a-number':
      return fail('weightKg', 'Enter your weight as a number.');
    case 'low':
      return fail('weightKg', `That is below ${describeWeight(LIMITS.weightKg.min, system)}. Check the units.`);
    case 'high':
      return fail('weightKg', `That is above ${describeWeight(LIMITS.weightKg.max, system)}. Check the units.`);
    default:
      return { ok: true, value: round(kg, 2) };
  }
}

function describeWeight(kg: number, system: UnitSystem): string {
  return system === 'metric' ? `${round(kg)} kg` : `${round(kgToLb(kg))} lb`;
}

/* ----------------------------------------------------------------- height */

/** Metric height: a single centimetre figure. */
export function validateHeightCm(input: string): Validated<number> {
  const raw = parseNumber(input);
  if (raw === null) return fail('heightCm', 'Enter your height.');
  return checkHeight(raw);
}

/**
 * Imperial height: feet and inches, as two fields.
 *
 * Two fields rather than one, because "5.9" is ambiguous — 5 feet 9, or 5 feet
 * and nine tenths of a foot — and the app should not have to guess which a
 * user meant about their own body.
 */
export function validateHeightFeetInches(
  feetInput: string,
  inchesInput: string,
): Validated<number> {
  const feet = parseNumber(feetInput);
  const inches = inchesInput.trim() === '' ? 0 : parseNumber(inchesInput);

  if (feet === null || inches === null) {
    return fail('heightCm', 'Enter your height in feet and inches.');
  }
  if (inches < 0 || inches >= 12) {
    return fail('heightCm', 'Inches must be between 0 and 11.');
  }
  if (feet < 0) return fail('heightCm', 'Enter your height in feet and inches.');

  return checkHeight(feetInchesToCm({ feet, inches }));
}

function checkHeight(cm: number): Validated<number> {
  switch (inRange(cm, LIMITS.heightCm)) {
    case 'not-a-number':
      return fail('heightCm', 'Enter your height as a number.');
    case 'low':
      return fail(
        'heightCm',
        `That is below ${LIMITS.heightCm.min} cm (${describeHeightImperial(LIMITS.heightCm.min)}). Check the units.`,
      );
    case 'high':
      return fail(
        'heightCm',
        `That is above ${LIMITS.heightCm.max} cm (${describeHeightImperial(LIMITS.heightCm.max)}). Check the units.`,
      );
    default:
      return { ok: true, value: round(cm, 1) };
  }
}

function describeHeightImperial(cm: number): string {
  const { feet, inches } = cmToFeetInches(cm);
  return `${feet}′ ${inches}″`;
}

/** A height typed in either system, resolved to centimetres. */
export function validateHeight(
  input: { cm?: string; feet?: string; inches?: string },
  system: UnitSystem,
): Validated<number> {
  return system === 'metric'
    ? validateHeightCm(input.cm ?? '')
    : validateHeightFeetInches(input.feet ?? '', input.inches ?? '');
}

/* -------------------------------------------------------------------- age */

export function validateAge(input: string): Validated<number> {
  const raw = parseNumber(input);
  if (raw === null) return fail('ageYears', 'Enter your age.');
  if (!Number.isInteger(raw)) return fail('ageYears', 'Enter your age in whole years.');

  switch (inRange(raw, LIMITS.ageYears)) {
    case 'low':
      return fail(
        'ageYears',
        `This calculator is for ages ${LIMITS.ageYears.min} and above.`,
      );
    case 'high':
      return fail('ageYears', 'Enter an age below 120.');
    case 'not-a-number':
      return fail('ageYears', 'Enter your age as a number.');
    default:
      return { ok: true, value: raw };
  }
}

/* ------------------------------------------------------- categorical input */

/**
 * Sex, for the equation.
 *
 * `unspecified` validates: declining to answer is a legitimate state, and the
 * profile's "other" maps to it. What must not happen is a default being
 * substituted downstream — `basalMetabolicRate` refuses instead, and the
 * calculator asks rather than guessing.
 */
export function validateSex(input: string | null | undefined): Validated<BiologicalSex> {
  if (input === 'male' || input === 'female' || input === 'unspecified') {
    return { ok: true, value: input };
  }
  // The profile's own enum, which allows "other".
  if (input === 'other') return { ok: true, value: 'unspecified' };
  return fail('sex', 'Choose an option so the estimate has something to work from.');
}

export function validateActivity(
  input: string | null | undefined,
): Validated<ActivityLevel> {
  const match = ACTIVITY_LEVELS.find((definition) => definition.level === input);
  return match
    ? { ok: true, value: match.level }
    : fail('activity', 'Choose how active you are.');
}

export function validateGoalDirection(
  input: string | null | undefined,
): Validated<GoalDirection> {
  if (input === 'lose' || input === 'maintain' || input === 'gain') {
    return { ok: true, value: input };
  }
  return fail('goal', 'Choose whether you want to lose, maintain or gain.');
}

/* ---------------------------------------------------------------- targets */

/**
 * A calorie target the user typed.
 *
 * The bounds here are input sanity only. Whether a valid figure is one the app
 * is willing to *recommend* is a different question, answered by the safety
 * floor — a target of 900 is accepted as an input and flagged as below the
 * floor, and those are two separate facts the UI keeps separate.
 */
export function validateCalorieTarget(input: string | number): Validated<number> {
  const raw = typeof input === 'number' ? input : parseNumber(input);
  if (raw === null) return fail('calorieTarget', 'Enter a calorie target.');
  if (!Number.isInteger(raw)) {
    return fail('calorieTarget', 'Enter a whole number of calories.');
  }

  switch (inRange(raw, LIMITS.calorieTarget)) {
    case 'low':
      return fail(
        'calorieTarget',
        `This app does not support targets below ${LIMITS.calorieTarget.min} kcal.`,
      );
    case 'high':
      return fail('calorieTarget', 'That target is higher than this app supports.');
    case 'not-a-number':
      return fail('calorieTarget', 'Enter the target as a number.');
    default:
      return { ok: true, value: raw };
  }
}

export interface MacroInput {
  readonly protein: string | number;
  readonly carbohydrates: string | number;
  readonly fat: string | number;
}

export interface ValidatedMacros {
  readonly protein_g: number;
  readonly carbohydrates_g: number;
  readonly fat_g: number;
}

/**
 * Macro targets the user typed.
 *
 * Validated together rather than one at a time, because the interesting
 * failure is a relationship: three individually reasonable numbers that add up
 * to something quite different from the calorie target. Every error is
 * collected so the user fixes them in one pass instead of one per attempt.
 */
export function validateMacroTargets(
  input: MacroInput,
  calorieTarget: number,
  tolerance = MACRO_TOLERANCE_KCAL,
): Validated<ValidatedMacros> {
  const errors: FieldError[] = [];

  const read = (
    value: string | number,
    field: 'proteinG' | 'carbohydratesG' | 'fatG',
    label: string,
  ): number | null => {
    const raw = typeof value === 'number' ? value : parseNumber(value);
    if (raw === null) {
      errors.push({ field, message: `Enter a ${label} target.` });
      return null;
    }
    const bounds = LIMITS[field];
    if (raw < bounds.min || raw > bounds.max || !Number.isFinite(raw)) {
      errors.push({
        field,
        message: `${label} must be between ${bounds.min} and ${bounds.max} g.`,
      });
      return null;
    }
    return raw;
  };

  const protein = read(input.protein, 'proteinG', 'protein');
  const carbohydrates = read(input.carbohydrates, 'carbohydratesG', 'carbohydrate');
  const fat = read(input.fat, 'fatG', 'fat');

  if (protein === null || carbohydrates === null || fat === null) {
    return { ok: false, errors };
  }

  const kcal = protein * 4 + carbohydrates * 4 + fat * 9;
  if (Math.abs(kcal - calorieTarget) > tolerance) {
    errors.push({
      field: 'calorieTarget',
      message: `These add up to ${Math.round(kcal)} kcal, which is ${Math.abs(
        Math.round(kcal - calorieTarget),
      )} kcal ${kcal > calorieTarget ? 'above' : 'below'} your ${calorieTarget} kcal target.`,
    });
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      protein_g: round(protein, 1),
      carbohydrates_g: round(carbohydrates, 1),
      fat_g: round(fat, 1),
    },
  };
}

/**
 * How far hand-entered macros may land from the calorie target.
 *
 * Wide enough that nobody has to solve a linear equation to save a form —
 * 50 kcal is about five grams of fat — and narrow enough that a set adding up
 * to a different target is caught rather than stored.
 */
export const MACRO_TOLERANCE_KCAL = 50;
