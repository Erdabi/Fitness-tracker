import { round } from './units';

/**
 * Energy requirements and nutrition targets.
 *
 * Every number the calculator shows is produced here, from inputs, by pure
 * functions. No React, no database, no I/O — so the formulas can be tested
 * directly and can never differ between the calculator screen, a recalculation
 * triggered from settings, and whatever reads them next.
 *
 * ── What this is, and is not ────────────────────────────────────────────────
 *
 * These are ESTIMATES from a population regression. Mifflin-St Jeor predicts
 * resting metabolic rate to within roughly ±10% for most people and further
 * off for some; activity multipliers are coarser still. The app says so, every
 * time it shows one, and this module is written so that nothing downstream can
 * present an estimate as a measurement.
 *
 * Nothing here is medical advice. The safety floor below is a PRODUCT rule
 * about what this app is willing to recommend on its own — not a claim about
 * what is safe for any particular person.
 */

/* ------------------------------------------------------------------ types */

/**
 * Biological sex, as the Mifflin-St Jeor equation requires it.
 *
 * `unspecified` is a real, expected value rather than an oversight: the profile
 * allows "other", and people decline to answer. The equation has no term for
 * it, so `basalMetabolicRate` refuses to guess — see `BmrResult`. Silently
 * substituting a default would produce a confident number with no basis, which
 * is worse than no number.
 */
export type BiologicalSex = 'male' | 'female' | 'unspecified';

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'very' | 'extra';

export type GoalDirection = 'lose' | 'maintain' | 'gain';

/** The inputs the equation needs, in canonical units. */
export interface BodyMetrics {
  readonly weightKg: number;
  readonly heightCm: number;
  readonly ageYears: number;
  readonly sex: BiologicalSex;
}

/* ------------------------------------------------------- activity levels */

export interface ActivityDefinition {
  readonly level: ActivityLevel;
  readonly multiplier: number;
  readonly label: string;
  /** Shown next to the choice: people cannot pick well from a label alone. */
  readonly description: string;
}

/**
 * Activity multipliers, in one place.
 *
 * The values are the conventional Harris-Benedict set, carried over to
 * Mifflin-St Jeor in practice and in most published calculators. They are
 * coarse by nature — the gap between "moderate" and "very" is 11% of a day's
 * energy, and no four-word description resolves that — which is exactly why
 * they live here as named constants with the descriptions attached, rather
 * than as numbers spread through the code.
 */
export const ACTIVITY_LEVELS: readonly ActivityDefinition[] = [
  {
    level: 'sedentary',
    multiplier: 1.2,
    label: 'Sedentary',
    description: 'Desk work, little or no deliberate exercise.',
  },
  {
    level: 'light',
    multiplier: 1.375,
    label: 'Lightly active',
    description: 'Light exercise or sport 1–3 days a week.',
  },
  {
    level: 'moderate',
    multiplier: 1.55,
    label: 'Moderately active',
    description: 'Moderate exercise or sport 3–5 days a week.',
  },
  {
    level: 'very',
    multiplier: 1.725,
    label: 'Very active',
    description: 'Hard exercise 6–7 days a week.',
  },
  {
    level: 'extra',
    multiplier: 1.9,
    label: 'Extra active',
    description: 'Hard daily exercise, or a physically demanding job.',
  },
];

const ACTIVITY_BY_LEVEL = new Map(
  ACTIVITY_LEVELS.map((definition) => [definition.level, definition]),
);

export function activityDefinition(level: ActivityLevel): ActivityDefinition {
  const definition = ACTIVITY_BY_LEVEL.get(level);
  if (!definition) {
    throw new Error(`Unknown activity level: ${String(level)}`);
  }
  return definition;
}

export function activityMultiplier(level: ActivityLevel): number {
  return activityDefinition(level).multiplier;
}

/* -------------------------------------------------------------- constants */

/**
 * Calorie adjustments, per day.
 *
 * Deliberately conservative. 500 kcal/day is about 0.45 kg (1 lb) a week, the
 * upper end of what is usually sustained; 300 kcal for a gain keeps more of it
 * lean. Both are defaults rather than limits — `calculateTargets` takes an
 * override — but nothing in the app produces a larger one on its own.
 */
export const CALORIE_ADJUSTMENTS: Readonly<Record<GoalDirection, number>> = {
  lose: -500,
  maintain: 0,
  gain: 300,
};

/**
 * The deficit is also capped as a share of maintenance.
 *
 * A flat 500 kcal off a 3,000 kcal maintenance is 17%; off a 1,600 kcal
 * maintenance it is 31%, which is a different proposition entirely. Capping
 * the *proportion* is what stops the same default from being mild for one
 * person and aggressive for another.
 */
export const MAX_DEFICIT_FRACTION = 0.25;
export const MAX_SURPLUS_FRACTION = 0.2;

/**
 * The floor below which this app will not recommend a calorie target.
 *
 * ── This is a product rule, not a medical one. ──────────────────────────────
 *
 * It is not a claim that these figures are safe for any given person, and the
 * app never says so. It is a statement about what this software is willing to
 * put on screen unprompted: below these numbers, an automatically generated
 * target stops being a helpful suggestion and starts being an instruction
 * nobody qualified has looked at.
 *
 * The values are the conventional lower bounds used across consumer nutrition
 * software. They are configurable here because they are a product decision,
 * and they are documented in docs/nutrition-goals.md as one.
 *
 * A user may still set a lower target by hand — see `acknowledgedBelowFloor` —
 * but the app will not arrive there on its own, and will not present it as a
 * normal recommendation.
 */
export const CALORIE_FLOOR_KCAL: Readonly<Record<BiologicalSex, number>> = {
  female: 1200,
  male: 1500,
  unspecified: 1200,
};

/**
 * A second floor, relative to the person rather than to a table.
 *
 * A recommendation below someone's own resting metabolic rate is one the app
 * should not generate, whatever the absolute numbers say. For a tall or heavy
 * person, BMR is the binding constraint long before 1,200 kcal is.
 */
export function calorieFloorFor(sex: BiologicalSex, bmr: number | null): number {
  const table = CALORIE_FLOOR_KCAL[sex];
  return bmr === null ? table : Math.max(table, Math.round(bmr));
}

/** Energy per gram. Fixed by definition, not by preference. */
export const KCAL_PER_GRAM = { protein: 4, carbohydrate: 4, fat: 9 } as const;

/**
 * Protein targets, in grams per kilogram of body weight.
 *
 * Higher in a deficit, where the job is to lose fat rather than muscle, and
 * higher again when gaining, where the surplus should build something.
 */
export const PROTEIN_G_PER_KG: Readonly<Record<GoalDirection, number>> = {
  lose: 1.8,
  maintain: 1.6,
  gain: 1.8,
};

/** Fat as a share of the calorie target, and the floor it may not fall below. */
export const FAT_FRACTION_OF_CALORIES = 0.25;
export const MIN_FAT_G_PER_KG = 0.5;
/** Protein may be trimmed to here, but no further, to make a target fit. */
export const MIN_PROTEIN_G_PER_KG = 1.2;

/**
 * Calorie figures are rounded to the nearest 10 kcal.
 *
 * The inputs carry nothing like single-calorie precision — the equation's own
 * error is measured in hundreds — so a target of 2,047 would imply an accuracy
 * the number does not have. Rounding to 10 also makes targets comparable
 * across recalculations: a kilogram of weight change moves the figure visibly
 * rather than by a digit nobody notices.
 *
 * BMR and TDEE are rounded to whole calories for display but carried at full
 * precision through the arithmetic, so rounding never compounds.
 */
export const CALORIE_ROUNDING_STEP = 10;

export function roundCalories(kcal: number): number {
  return Math.round(kcal / CALORIE_ROUNDING_STEP) * CALORIE_ROUNDING_STEP;
}

/** Rounds up to the step. Used where a lower bound must survive rounding. */
export function ceilCalories(kcal: number): number {
  return Math.ceil(kcal / CALORIE_ROUNDING_STEP) * CALORIE_ROUNDING_STEP;
}

/* -------------------------------------------------------------------- BMR */

export type BmrResult =
  | { readonly ok: true; readonly bmr: number }
  /**
   * The equation cannot run. `reason` distinguishes "you have not told us your
   * sex" from "these numbers are not a person", because the two need different
   * things from the user.
   */
  | { readonly ok: false; readonly reason: 'sex-unspecified' | 'invalid-metrics' };

/**
 * Mifflin-St Jeor.
 *
 *   male:   10 × kg + 6.25 × cm − 5 × age + 5
 *   female: 10 × kg + 6.25 × cm − 5 × age − 161
 *
 * Returns a result rather than a number because there are two states that are
 * genuinely not a number: sex not given, and metrics that are not physically
 * possible. Throwing would push the handling into every call site; returning a
 * default would invent one.
 */
export function basalMetabolicRate(metrics: BodyMetrics): BmrResult {
  if (
    !Number.isFinite(metrics.weightKg) ||
    !Number.isFinite(metrics.heightCm) ||
    !Number.isFinite(metrics.ageYears) ||
    metrics.weightKg <= 0 ||
    metrics.heightCm <= 0 ||
    metrics.ageYears < 0
  ) {
    return { ok: false, reason: 'invalid-metrics' };
  }

  if (metrics.sex === 'unspecified') {
    return { ok: false, reason: 'sex-unspecified' };
  }

  const base =
    10 * metrics.weightKg + 6.25 * metrics.heightCm - 5 * metrics.ageYears;

  return { ok: true, bmr: metrics.sex === 'male' ? base + 5 : base - 161 };
}

/**
 * Total daily energy expenditure — BMR scaled by an activity multiplier.
 *
 * An estimate built on an estimate. The UI labels it as one everywhere it
 * appears, and this module has no way to express it as anything else.
 */
export function totalDailyEnergyExpenditure(
  bmr: number,
  level: ActivityLevel,
): number {
  return bmr * activityMultiplier(level);
}

/* ---------------------------------------------------------------- targets */

export interface MacroTargets {
  readonly protein_g: number;
  readonly carbohydrates_g: number;
  readonly fat_g: number;
}

export interface TargetOptions {
  /** Overrides the default adjustment for the direction. Signed kcal/day. */
  readonly calorieAdjustment?: number;
  readonly proteinGPerKg?: number;
  readonly fatFraction?: number;
}

export interface CalculatedTargets {
  readonly bmr: number;
  /** Maintenance. The number a user is compared against, not a target. */
  readonly tdee: number;
  /** The adjustment actually applied, after the proportional cap. */
  readonly appliedAdjustment: number;
  /** What the arithmetic produced, before the floor. */
  readonly rawTarget: number;
  /** What the app recommends. Never below `floor`. */
  readonly calorieTarget: number;
  readonly macros: MacroTargets;
  /** The binding floor for this person, whichever of the two rules won. */
  readonly floor: number;
  /**
   * True when the floor moved the recommendation. The UI must say so — a
   * target that is 1,200 because the floor caught it is a different fact from
   * a target that is 1,200 because the arithmetic landed there.
   */
  readonly floorApplied: boolean;
}

/**
 * The whole calculation, from body metrics to macro targets.
 *
 * Order matters and is deliberate: adjust, cap the adjustment proportionally,
 * apply the floor, round, then split the *rounded* target into macros. Macros
 * derived from an unrounded target would not add up to the number on screen.
 */
export function calculateTargets(
  metrics: BodyMetrics,
  level: ActivityLevel,
  direction: GoalDirection,
  options: TargetOptions = {},
): CalculatedTargets | null {
  const bmrResult = basalMetabolicRate(metrics);
  if (!bmrResult.ok) return null;

  const { bmr } = bmrResult;
  const tdee = totalDailyEnergyExpenditure(bmr, level);

  const requested = options.calorieAdjustment ?? CALORIE_ADJUSTMENTS[direction];
  const appliedAdjustment = capAdjustment(requested, tdee);

  const rawTarget = tdee + appliedAdjustment;
  const floor = calorieFloorFor(metrics.sex, bmr);

  /*
   * The floor is applied twice: once to the figure, and again after rounding.
   *
   * Rounding to the nearest 10 can cross the floor on its own — a raw target
   * of 2,514 against a floor of 2,511 rounds to 2,510, one calorie under the
   * bound, without the floor ever having "applied". The step is a display
   * convention; the floor is a rule, and a rule that rounding can cross is
   * not one. So when the nearest step lands below it, round up instead.
   */
  const nearest = roundCalories(Math.max(rawTarget, floor));
  const calorieTarget = nearest < floor ? ceilCalories(floor) : nearest;

  return {
    bmr,
    tdee,
    appliedAdjustment,
    rawTarget: roundCalories(rawTarget),
    calorieTarget,
    macros: macroTargets(calorieTarget, metrics.weightKg, direction, options),
    floor,
    /*
     * Reported only when the arithmetic genuinely wanted less than the floor.
     * A target nudged up ten calories so that rounding does not cross the
     * bound is not the floor intervening, and saying so would put a warning
     * in front of someone whose numbers were fine.
     */
    floorApplied: rawTarget < floor,
  };
}

/** Clamps an adjustment to a share of maintenance. See MAX_DEFICIT_FRACTION. */
export function capAdjustment(adjustment: number, tdee: number): number {
  if (adjustment < 0) return Math.max(adjustment, -tdee * MAX_DEFICIT_FRACTION);
  if (adjustment > 0) return Math.min(adjustment, tdee * MAX_SURPLUS_FRACTION);
  return 0;
}

/**
 * Splits a calorie target into protein, fat and carbohydrate.
 *
 * Protein and fat are set first — protein from body weight, fat as a share of
 * the target — and carbohydrate takes what is left. That order is the reason
 * the three reconcile: only one of them absorbs the remainder, so only one can
 * be wrong, and it is the one with the widest sensible range.
 *
 * Both are rounded to whole grams *before* carbohydrate is computed, so the
 * numbers on screen add up to the target rather than to an unrounded figure
 * behind it. See `macroCalories` for the tolerance this leaves.
 *
 * When a target is too small to hold both — a low floor against a heavy body —
 * fat is trimmed to `MIN_FAT_G_PER_KG` and then protein to
 * `MIN_PROTEIN_G_PER_KG`, and carbohydrate bottoms out at zero rather than
 * going negative.
 */
export function macroTargets(
  calorieTarget: number,
  weightKg: number,
  direction: GoalDirection,
  options: TargetOptions = {},
): MacroTargets {
  const proteinPerKg = options.proteinGPerKg ?? PROTEIN_G_PER_KG[direction];
  const fatFraction = options.fatFraction ?? FAT_FRACTION_OF_CALORIES;

  let protein = Math.round(weightKg * proteinPerKg);
  let fat = Math.max(
    Math.round((calorieTarget * fatFraction) / KCAL_PER_GRAM.fat),
    Math.round(weightKg * MIN_FAT_G_PER_KG),
  );

  /*
   * Make room, cheapest concession first: fat down to its floor, then protein.
   *
   * In practice fat is usually already there — its floor only loses to the
   * 25% share at targets high enough that nothing needs trimming — so the step
   * that actually fires for a heavy person on a low target is the protein one.
   * The ordering is still the right way round: protein is what preserves lean
   * mass in a deficit, so it gives way last.
   */
  const minFat = Math.round(weightKg * MIN_FAT_G_PER_KG);
  const minProtein = Math.round(weightKg * MIN_PROTEIN_G_PER_KG);

  if (proteinKcal(protein) + fatKcal(fat) > calorieTarget) {
    const roomForFat = calorieTarget - proteinKcal(protein);
    fat = Math.max(minFat, Math.min(fat, Math.floor(roomForFat / KCAL_PER_GRAM.fat)));
  }

  if (proteinKcal(protein) + fatKcal(fat) > calorieTarget) {
    const roomForProtein = calorieTarget - fatKcal(fat);
    protein = Math.max(
      minProtein,
      Math.min(protein, Math.floor(roomForProtein / KCAL_PER_GRAM.protein)),
    );
  }

  /*
   * Last resort: a target too small to hold even the two minimums.
   *
   * Reachable only from a hand-entered target — the calculated path floors at
   * the person's own resting rate, which is far above this — and it has to be
   * handled anyway, because the alternative is three numbers on screen that
   * visibly add up to more than the target above them. Splitting what there is
   * in the ratio of the two minimums keeps protein's priority, fits exactly,
   * and stays deterministic.
   *
   * That the target is below what this app is willing to recommend is a
   * separate fact, and the safety floor reports it separately.
   */
  if (proteinKcal(protein) + fatKcal(fat) > calorieTarget) {
    const proteinShare = proteinKcal(minProtein);
    const fatShare = fatKcal(minFat);
    const total = proteinShare + fatShare;

    if (total > 0) {
      const scale = calorieTarget / total;
      protein = Math.floor((proteinShare * scale) / KCAL_PER_GRAM.protein);
      fat = Math.floor((fatShare * scale) / KCAL_PER_GRAM.fat);
    } else {
      protein = 0;
      fat = 0;
    }
  }

  const remaining = calorieTarget - proteinKcal(protein) - fatKcal(fat);
  const carbohydrates = Math.max(0, Math.round(remaining / KCAL_PER_GRAM.carbohydrate));

  return {
    protein_g: Math.max(0, protein),
    carbohydrates_g: carbohydrates,
    fat_g: Math.max(0, fat),
  };
}

const proteinKcal = (grams: number): number => grams * KCAL_PER_GRAM.protein;
const fatKcal = (grams: number): number => grams * KCAL_PER_GRAM.fat;

/** The calories the macro targets actually add up to. */
export function macroCalories(macros: MacroTargets): number {
  return (
    macros.protein_g * KCAL_PER_GRAM.protein +
    macros.carbohydrates_g * KCAL_PER_GRAM.carbohydrate +
    macros.fat_g * KCAL_PER_GRAM.fat
  );
}

/**
 * How far the macro split lands from the calorie target.
 *
 * Non-zero by construction: three whole-gram numbers cannot always hit a
 * multiple of ten exactly. Rounding carbohydrate last bounds the gap at
 * 2 kcal — half a gram either way — unless a floor forced protein or fat off
 * their intended values, which the UI reports separately.
 */
export function macroReconciliation(
  macros: MacroTargets,
  calorieTarget: number,
): number {
  return macroCalories(macros) - calorieTarget;
}

/* --------------------------------------------------------------- progress */

export interface GoalProgress {
  readonly consumed: number;
  readonly target: number;
  /** Signed. Negative means the target was exceeded — see `overBy`. */
  readonly remaining: number;
  readonly isOver: boolean;
  /** How far past the target, or 0. Never a negative "allowance". */
  readonly overBy: number;
  /** 0–1, clamped, for a progress bar. Exceeding the target reads as full. */
  readonly fraction: number;
}

/**
 * Consumption against a target.
 *
 * `remaining` is signed because the arithmetic is; `overBy` exists so no
 * screen has to negate it and no screen can accidentally render "−240" in a
 * field labelled "remaining", which reads as an allowance rather than an
 * overage.
 */
export function goalProgress(consumed: number, target: number): GoalProgress {
  const remaining = target - consumed;
  const isOver = remaining < 0;

  return {
    consumed,
    target,
    remaining,
    isOver,
    overBy: isOver ? -remaining : 0,
    fraction: target <= 0 ? 0 : Math.min(1, Math.max(0, consumed / target)),
  };
}

/* ------------------------------------------------------------------- misc */

/** Whole years from a birth date to `on`, in calendar terms. */
export function ageOn(birthDate: string, on: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return null;

  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const born = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(born)) return null;

  // Compare in UTC calendar terms: a birthday is a date, not an instant, and
  // must not shift by a day because the device is west of Greenwich.
  const reference = Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate());
  if (reference < born) return null;

  let age = on.getUTCFullYear() - year;
  const hadBirthday =
    on.getUTCMonth() + 1 > month ||
    (on.getUTCMonth() + 1 === month && on.getUTCDate() >= day);
  if (!hadBirthday) age -= 1;

  return age;
}

/** Display helper, kept here so rounding lives with the arithmetic. */
export function displayBmr(bmr: number): number {
  return round(bmr, 0);
}
