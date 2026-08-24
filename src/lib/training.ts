import { kgToLb, lbToKg, round } from './units';

/**
 * Training arithmetic.
 *
 * Everything a set means, computed in one place and never inside a component.
 * Two rules shape the whole file:
 *
 *   • **Kilograms are canonical.** A weight is a number of kilograms plus a
 *     note of what the user was typing in. Nothing here accepts or returns a
 *     display string, and nothing stores one — a column holding both "70" and
 *     "155 lb" cannot be repaired after the fact.
 *
 *   • **A metric that does not apply returns null, not zero.** An estimated
 *     one-rep max for a set of push-ups is not "0 kg"; it is a question the
 *     data cannot answer. Zero would sort, average and chart as though it
 *     meant something.
 */

/* ------------------------------------------------------------- load types */

/**
 * How a set is measured, mirroring `public.exercise_load_type`.
 *
 *   weighted    External load and reps. Bench press, squat.
 *   bodyweight  Reps, with optional *added* load. Push-ups, pull-ups.
 *   duration    A time held. Plank, dead hang.
 *   distance    A distance, usually with a time. Running, rowing.
 */
export type LoadType = 'weighted' | 'bodyweight' | 'duration' | 'distance';

export const LOAD_TYPES: readonly LoadType[] = [
  'weighted',
  'bodyweight',
  'duration',
  'distance',
];

/** The display unit a weight was entered in. Never the value itself. */
export type WeightUnit = 'kg' | 'lb';

/**
 * One set, as the arithmetic sees it.
 *
 * Nullable throughout because the four load types measure different things,
 * and a plank genuinely has no reps.
 */
export interface SetMeasurement {
  /** Canonical external load. 0 means "no added weight"; null means "not measured that way". */
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly distanceM: number | null;
  readonly isCompleted: boolean;
}

/* -------------------------------------------------------------- unit edge */

/**
 * Converts a typed weight into canonical kilograms.
 *
 * The single entry point from the UI. Rounded to three decimals because that
 * is the column's scale — carrying more precision than the database keeps
 * would make a value change silently on its first round trip.
 */
export function toCanonicalKg(value: number, unit: WeightUnit): number {
  return round(unit === 'lb' ? lbToKg(value) : value, 3);
}

/**
 * Converts canonical kilograms back into the unit the user types in.
 *
 * Rounded to a plate-sensible precision: gyms are stocked in 1.25 kg and
 * 2.5 lb steps, so more than one decimal is noise the user cannot act on.
 */
export function fromCanonicalKg(kg: number, unit: WeightUnit): number {
  return round(unit === 'lb' ? kgToLb(kg) : kg, 1);
}

/** "70 kg", "155 lb", or "bodyweight" when there is no added load. */
export function formatLoad(
  weightKg: number | null,
  unit: WeightUnit,
  loadType: LoadType,
): string {
  if (weightKg === null) return '';
  if (weightKg === 0) return loadType === 'bodyweight' ? 'bodyweight' : `0 ${unit}`;
  return `${fromCanonicalKg(weightKg, unit)} ${unit}`;
}

/* ------------------------------------------------------------- validation */

export interface SetProblem {
  readonly field: 'weightKg' | 'reps' | 'durationSeconds' | 'distanceM' | 'setNumber';
  readonly message: string;
}

/**
 * Bounds mirroring the CHECK constraints on `public.workout_sets`.
 *
 * Duplicated deliberately, and the duplication is the point: the database is
 * the authority, and these exist so a user gets a message under the field
 * instead of a failed insert three screens later. `training.test.sql` proves
 * the database rejects the same values, so a drift here costs a worse error
 * message, never bad data.
 */
export const SET_LIMITS = {
  maxWeightKg: 1000,
  maxReps: 1000,
  maxDurationSeconds: 86_400,
  maxDistanceM: 1_000_000,
  maxSetNumber: 100,
} as const;

/**
 * Whether a set could have happened, given how the exercise is measured.
 *
 * The load type decides which fields are *required*, not merely which are
 * allowed: a weighted set with no reps and a plank with no duration are both
 * rows that render as an empty line and count towards nothing.
 */
export function validateSet(
  set: Partial<SetMeasurement> & { setNumber?: number },
  loadType: LoadType,
): SetProblem[] {
  const problems: SetProblem[] = [];

  const finite = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);

  if (set.setNumber !== undefined) {
    if (!Number.isInteger(set.setNumber) || set.setNumber < 1) {
      problems.push({ field: 'setNumber', message: 'Sets are numbered from 1.' });
    } else if (set.setNumber > SET_LIMITS.maxSetNumber) {
      problems.push({
        field: 'setNumber',
        message: `${SET_LIMITS.maxSetNumber} sets of one exercise is already a lot.`,
      });
    }
  }

  if (set.weightKg !== null && set.weightKg !== undefined) {
    if (!finite(set.weightKg) || set.weightKg < 0) {
      // There is no such thing as a negative external load. Assistance is
      // modelled as a bodyweight exercise, not as a negative weight.
      problems.push({ field: 'weightKg', message: 'Weight cannot be negative.' });
    } else if (set.weightKg > SET_LIMITS.maxWeightKg) {
      problems.push({
        field: 'weightKg',
        message: `${round(set.weightKg, 1)} kg looks like a slipped decimal point.`,
      });
    }
  }

  if (set.reps !== null && set.reps !== undefined) {
    if (!Number.isInteger(set.reps) || set.reps < 0) {
      problems.push({ field: 'reps', message: 'Reps must be a whole number, 0 or more.' });
    } else if (set.reps > SET_LIMITS.maxReps) {
      problems.push({ field: 'reps', message: 'That is more reps than anyone has done.' });
    }
  }

  if (set.durationSeconds !== null && set.durationSeconds !== undefined) {
    if (!finite(set.durationSeconds) || set.durationSeconds <= 0) {
      problems.push({ field: 'durationSeconds', message: 'A held set lasts longer than zero.' });
    } else if (set.durationSeconds > SET_LIMITS.maxDurationSeconds) {
      problems.push({ field: 'durationSeconds', message: 'That is longer than a day.' });
    }
  }

  if (set.distanceM !== null && set.distanceM !== undefined) {
    if (!finite(set.distanceM) || set.distanceM <= 0) {
      problems.push({ field: 'distanceM', message: 'A distance is greater than zero.' });
    } else if (set.distanceM > SET_LIMITS.maxDistanceM) {
      problems.push({ field: 'distanceM', message: 'That is further than 1000 km.' });
    }
  }

  // What this kind of exercise has to record to mean anything.
  const required = requiredFieldFor(loadType);
  const present =
    required === 'reps'
      ? set.reps !== null && set.reps !== undefined
      : required === 'durationSeconds'
        ? set.durationSeconds !== null && set.durationSeconds !== undefined
        : set.distanceM !== null && set.distanceM !== undefined;

  if (!present && !problems.some((problem) => problem.field === required)) {
    problems.push({ field: required, message: MISSING_MESSAGE[required] });
  }

  return problems;
}

function requiredFieldFor(loadType: LoadType): 'reps' | 'durationSeconds' | 'distanceM' {
  if (loadType === 'duration') return 'durationSeconds';
  if (loadType === 'distance') return 'distanceM';
  return 'reps';
}

const MISSING_MESSAGE = {
  reps: 'How many reps?',
  durationSeconds: 'How long was it held?',
  distanceM: 'How far?',
} as const;

/* ------------------------------------------------------------------ volume */

/**
 * Volume: load moved, in kilograms.
 *
 * `weight × reps`, summed over completed sets. A crude measure and a useful
 * one — it is the number that moves when a session gets harder in any of the
 * three ways it can.
 *
 * Returns null rather than 0 when the exercise has no external load to
 * multiply: 20 push-ups is not "0 kg of volume", and charting it as zero would
 * make a bodyweight session look like a rest day. A bodyweight set with added
 * weight *does* have volume — the added load is real load.
 *
 * Incomplete sets are excluded. A set the user planned but did not perform is
 * not work done.
 */
export function setVolumeKg(set: SetMeasurement, loadType: LoadType): number | null {
  if (!set.isCompleted) return 0;
  if (loadType === 'duration' || loadType === 'distance') return null;
  if (set.weightKg === null || set.reps === null) return null;
  if (set.weightKg === 0) return 0;

  return round(set.weightKg * set.reps, 3);
}

/**
 * Volume across sets.
 *
 * Null only when *no* set could contribute one — a plank has no volume at all,
 * whereas a session of push-ups with one weighted set has the volume of that
 * set.
 */
export function totalVolumeKg(
  sets: readonly SetMeasurement[],
  loadType: LoadType,
): number | null {
  const contributions = sets
    .map((set) => setVolumeKg(set, loadType))
    .filter((value): value is number => value !== null);

  if (contributions.length === 0) return null;

  return round(
    contributions.reduce((total, value) => total + value, 0),
    3,
  );
}

/* ---------------------------------------------------------- estimated 1RM */

/**
 * The Epley coefficient: 1RM ≈ weight × (1 + reps / 30).
 *
 * Chosen because it is transparent — one multiplication a user can check on
 * paper — rather than because it is the most accurate of the several published
 * formulas. They disagree with each other by more than the choice between them
 * matters at the rep ranges people actually train in.
 */
export const EPLEY_DIVISOR = 30;

/**
 * Above this many reps, an estimate stops being an estimate.
 *
 * Epley was fitted to low-rep work. At 20 reps it claims a one-rep max 67%
 * above the weight on the bar, which is a statement about endurance, not about
 * maximal strength. Refusing beyond 12 keeps the number inside the range where
 * it means what it says.
 */
export const MAX_REPS_FOR_1RM = 12;

/**
 * Whether an estimated one-rep max is a meaningful number for this exercise.
 *
 * Only `weighted`. The other three are excluded for reasons, not by omission:
 *
 *   • **bodyweight** — the load that matters includes the user's bodyweight,
 *     which this data does not carry. Epley on the *added* load alone gives a
 *     one-rep max of 0 kg for 20 push-ups, which is worse than no answer.
 *   • **duration** and **distance** — there is no weight to project from.
 */
export function supportsOneRepMax(loadType: LoadType): boolean {
  return loadType === 'weighted';
}

/**
 * Estimated one-rep max, in kilograms. **An estimate, never a measurement.**
 *
 * Returns null whenever the number would not mean anything: an unsuitable
 * exercise, an incomplete set, no load, or a rep count outside the range the
 * formula was fitted to. Callers must render null as "—", never as 0.
 *
 * A single rep returns the weight itself, which is the formula's own answer
 * and also the honest one: a set of one *is* a one-rep max.
 */
export function estimatedOneRepMaxKg(
  set: SetMeasurement,
  loadType: LoadType,
): number | null {
  if (!supportsOneRepMax(loadType)) return null;
  if (!set.isCompleted) return null;
  if (set.weightKg === null || set.reps === null) return null;
  if (set.weightKg <= 0 || set.reps <= 0) return null;
  if (set.reps > MAX_REPS_FOR_1RM) return null;

  return round(set.weightKg * (1 + set.reps / EPLEY_DIVISOR), 1);
}

/** The best estimate across sets, or null when none of them supports one. */
export function bestOneRepMaxKg(
  sets: readonly SetMeasurement[],
  loadType: LoadType,
): number | null {
  const estimates = sets
    .map((set) => estimatedOneRepMaxKg(set, loadType))
    .filter((value): value is number => value !== null);

  return estimates.length === 0 ? null : Math.max(...estimates);
}

/* ------------------------------------------------------------ progression */

export interface ExerciseSummary {
  /** Load moved, in kg. Null when the exercise has no external load. */
  readonly volumeKg: number | null;
  /** Heaviest completed set. Null when nothing was loaded. */
  readonly bestWeightKg: number | null;
  /** Most reps in a completed set. Null for duration and distance work. */
  readonly bestReps: number | null;
  /** Longest completed hold, in seconds. */
  readonly bestDurationSeconds: number | null;
  /** Furthest completed distance, in metres. */
  readonly bestDistanceM: number | null;
  /** Epley. Null whenever the metric does not apply — see `supportsOneRepMax`. */
  readonly estimatedOneRepMaxKg: number | null;
  readonly completedSets: number;
}

/**
 * Everything the progression view shows for one exercise in one session.
 *
 * Computed together rather than as six separate passes so a caller cannot
 * accidentally mix a figure from completed sets with one from all sets.
 */
export function summariseExercise(
  sets: readonly SetMeasurement[],
  loadType: LoadType,
): ExerciseSummary {
  const completed = sets.filter((set) => set.isCompleted);

  const best = (pick: (set: SetMeasurement) => number | null): number | null => {
    const values = completed
      .map(pick)
      .filter((value): value is number => value !== null);
    return values.length === 0 ? null : Math.max(...values);
  };

  const isTimed = loadType === 'duration' || loadType === 'distance';

  return {
    volumeKg: totalVolumeKg(sets, loadType),
    bestWeightKg: best((set) => set.weightKg),
    bestReps: isTimed ? null : best((set) => set.reps),
    bestDurationSeconds: best((set) => set.durationSeconds),
    bestDistanceM: best((set) => set.distanceM),
    estimatedOneRepMaxKg: bestOneRepMaxKg(sets, loadType),
    completedSets: completed.length,
  };
}

/* --------------------------------------------------------------- ordering */

/**
 * Moves the item at `from` to `to`, returning fresh positions.
 *
 * Renumbers densely from zero rather than assigning fractional positions: the
 * list is short, the column is an integer with a unique constraint, and dense
 * integers mean two devices that reorder the same session converge on a
 * comparable answer instead of drifting apart by fractions nobody can read.
 *
 * Out-of-range indices return the input unchanged — a drag that ends outside
 * the list is a cancelled drag, not an error.
 */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= next.length ||
    to >= next.length ||
    from === to
  ) {
    return next;
  }

  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/** Positions after a move, as `[id, position]` pairs ready to write. */
export function reorderedPositions(
  ids: readonly string[],
  from: number,
  to: number,
): { id: string; position: number }[] {
  return reorder(ids, from, to).map((id, position) => ({ id, position }));
}

/* --------------------------------------------------------------- duration */

/**
 * Elapsed seconds between two instants, floored at zero.
 *
 * Floored because a device whose clock is corrected backwards mid-session
 * would otherwise show a negative timer, which reads as a bug rather than as
 * the clock adjustment it is.
 */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** `1:04:09` past an hour, `4:09` below it. Never `0:4`. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const pad = (value: number): string => String(value).padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * The timer, spelled out for a screen reader.
 *
 * `4:09` is read as "four hundred nine" or "four colon zero nine" depending on
 * the reader, and neither is a duration. This is.
 */
export function describeDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  }

  return parts.join(' ');
}

/**
 * One set, spelled out for a screen reader.
 *
 * "70 kg by 8" rather than "70 × 8", because the multiplication sign is either
 * skipped or read as "x" depending on the reader and the verbosity setting.
 */
export function describeSet(
  set: SetMeasurement,
  loadType: LoadType,
  unit: WeightUnit,
): string {
  const parts: string[] = [];

  if (set.weightKg !== null && set.weightKg > 0) {
    parts.push(`${fromCanonicalKg(set.weightKg, unit)} ${unit === 'kg' ? 'kilograms' : 'pounds'}`);
  } else if (loadType === 'bodyweight' && set.weightKg === 0) {
    parts.push('bodyweight');
  }

  if (set.reps !== null) parts.push(`${set.reps} rep${set.reps === 1 ? '' : 's'}`);
  if (set.durationSeconds !== null) parts.push(describeDuration(set.durationSeconds));
  if (set.distanceM !== null) parts.push(`${round(set.distanceM, 0)} metres`);

  const body = parts.length > 0 ? parts.join(', ') : 'nothing recorded';
  return set.isCompleted ? `${body}, done` : body;
}
