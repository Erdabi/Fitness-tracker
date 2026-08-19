/**
 * Unit conversion.
 *
 * Storage is always SI: grams, millilitres, kilograms, centimetres. Conversion
 * happens only at the display boundary. Mixed storage units are the most common
 * source of corrupt data in fitness apps — a weight column holding both kg and
 * lb cannot be repaired after the fact.
 */

export type UnitSystem = 'metric' | 'imperial';

const KG_PER_LB = 0.45359237;
const CM_PER_INCH = 2.54;
const ML_PER_FL_OZ = 29.5735295625;
const INCHES_PER_FOOT = 12;

/* ------------------------------------------------------------------ mass -- */

export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;

/* ---------------------------------------------------------------- length -- */

export const inchesToCm = (inches: number): number => inches * CM_PER_INCH;
export const cmToInches = (cm: number): number => cm / CM_PER_INCH;

export interface FeetInches {
  readonly feet: number;
  readonly inches: number;
}

export function cmToFeetInches(cm: number): FeetInches {
  const totalInches = cmToInches(cm);
  const feet = Math.floor(totalInches / INCHES_PER_FOOT);
  const inches = totalInches - feet * INCHES_PER_FOOT;
  // Rounding can push inches to exactly 12; carry into feet so "5' 12"" never
  // reaches the UI.
  const rounded = Math.round(inches);
  return rounded === INCHES_PER_FOOT
    ? { feet: feet + 1, inches: 0 }
    : { feet, inches: rounded };
}

export function feetInchesToCm({ feet, inches }: FeetInches): number {
  return inchesToCm(feet * INCHES_PER_FOOT + inches);
}

/* ---------------------------------------------------------------- volume -- */

export const flOzToMl = (flOz: number): number => flOz * ML_PER_FL_OZ;
export const mlToFlOz = (ml: number): number => ml / ML_PER_FL_OZ;

/* -------------------------------------------------------------- rounding -- */

/** Rounds to `decimals` places without float drift on .5 boundaries. */
export function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/* ------------------------------------------------------------ formatting -- */

export function formatWeight(kg: number, system: UnitSystem): string {
  return system === 'metric' ? `${round(kg, 1)} kg` : `${round(kgToLb(kg), 1)} lb`;
}

export function formatHeight(cm: number, system: UnitSystem): string {
  if (system === 'metric') return `${round(cm)} cm`;
  const { feet, inches } = cmToFeetInches(cm);
  return `${feet}′ ${inches}″`;
}

export function formatVolume(ml: number, system: UnitSystem): string {
  if (system === 'metric') {
    return ml >= 1000 ? `${round(ml / 1000, 2)} L` : `${round(ml)} ml`;
  }
  return `${round(mlToFlOz(ml))} fl oz`;
}

/** Energy is kcal in both systems; centralised so call sites stay uniform. */
export function formatEnergy(kcal: number): string {
  return `${Math.round(kcal).toLocaleString()} kcal`;
}
