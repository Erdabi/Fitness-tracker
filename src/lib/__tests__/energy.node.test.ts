import {
  ACTIVITY_LEVELS,
  CALORIE_ADJUSTMENTS,
  CALORIE_FLOOR_KCAL,
  CALORIE_ROUNDING_STEP,
  KCAL_PER_GRAM,
  MAX_DEFICIT_FRACTION,
  MAX_SURPLUS_FRACTION,
  MIN_FAT_G_PER_KG,
  MIN_PROTEIN_G_PER_KG,
  activityMultiplier,
  ageOn,
  basalMetabolicRate,
  calculateTargets,
  calorieFloorFor,
  capAdjustment,
  goalProgress,
  macroCalories,
  macroReconciliation,
  macroTargets,
  roundCalories,
  totalDailyEnergyExpenditure,
  type ActivityLevel,
  type BodyMetrics,
  type GoalDirection,
} from '../energy';

/**
 * The calculator's arithmetic.
 *
 * Two kinds of test here, deliberately. Worked examples pin the formulas to
 * numbers computed by hand, so a transposed coefficient is caught. Property
 * tests pin the *relationships* — heavier means higher, macros reconcile, a
 * floor is never crossed — which is where a refactor breaks things that no
 * single example happens to cover.
 */

const ADULT: BodyMetrics = {
  weightKg: 80,
  heightCm: 180,
  ageYears: 30,
  sex: 'male',
};

describe('basalMetabolicRate', () => {
  /* 10×80 + 6.25×180 − 5×30 + 5 = 800 + 1125 − 150 + 5 */
  it('computes Mifflin-St Jeor for males', () => {
    const result = basalMetabolicRate(ADULT);
    expect(result).toEqual({ ok: true, bmr: 1780 });
  });

  /* 10×65 + 6.25×165 − 5×30 − 161 = 650 + 1031.25 − 150 − 161 */
  it('computes Mifflin-St Jeor for females', () => {
    const result = basalMetabolicRate({
      weightKg: 65,
      heightCm: 165,
      ageYears: 30,
      sex: 'female',
    });
    expect(result).toEqual({ ok: true, bmr: 1370.25 });
  });

  it('differs by exactly 166 between the sexes at equal metrics', () => {
    const male = basalMetabolicRate({ ...ADULT, sex: 'male' });
    const female = basalMetabolicRate({ ...ADULT, sex: 'female' });

    expect(male.ok && female.ok && male.bmr - female.bmr).toBe(166);
  });

  it.each([
    ['a small adult', { weightKg: 45, heightCm: 150, ageYears: 25, sex: 'female' as const }, 1101.5],
    ['a large adult', { weightKg: 140, heightCm: 200, ageYears: 40, sex: 'male' as const }, 2455],
    ['an older adult', { weightKg: 70, heightCm: 170, ageYears: 75, sex: 'female' as const }, 1226.5],
    ['the youngest supported age', { weightKg: 50, heightCm: 160, ageYears: 13, sex: 'male' as const }, 1440],
  ])('computes %s', (_label, metrics, expected) => {
    const result = basalMetabolicRate(metrics);
    expect(result.ok && result.bmr).toBeCloseTo(expected, 6);
  });

  /**
   * The equation has no term for an unspecified sex. Substituting one would
   * produce a confident number with nothing behind it.
   */
  it('refuses rather than assuming a sex', () => {
    expect(basalMetabolicRate({ ...ADULT, sex: 'unspecified' })).toEqual({
      ok: false,
      reason: 'sex-unspecified',
    });
  });

  it.each([
    ['zero weight', { ...ADULT, weightKg: 0 }],
    ['negative weight', { ...ADULT, weightKg: -80 }],
    ['zero height', { ...ADULT, heightCm: 0 }],
    ['a negative age', { ...ADULT, ageYears: -1 }],
    ['NaN', { ...ADULT, weightKg: Number.NaN }],
    ['Infinity', { ...ADULT, heightCm: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_label, metrics) => {
    expect(basalMetabolicRate(metrics)).toEqual({
      ok: false,
      reason: 'invalid-metrics',
    });
  });

  /**
   * The distinction matters to the caller: "tell us your sex" and "those
   * numbers are not a person" need different things from the user.
   */
  it('reports invalid metrics ahead of an unspecified sex', () => {
    const result = basalMetabolicRate({ ...ADULT, sex: 'unspecified', weightKg: 0 });
    expect(result).toEqual({ ok: false, reason: 'invalid-metrics' });
  });
});

describe('activity multipliers', () => {
  it('exposes the five documented levels', () => {
    expect(ACTIVITY_LEVELS.map((level) => level.level)).toEqual([
      'sedentary',
      'light',
      'moderate',
      'very',
      'extra',
    ]);
  });

  it.each([
    ['sedentary', 1.2],
    ['light', 1.375],
    ['moderate', 1.55],
    ['very', 1.725],
    ['extra', 1.9],
  ] as [ActivityLevel, number][])('uses %s = %s', (level, multiplier) => {
    expect(activityMultiplier(level)).toBe(multiplier);
  });

  it('gives every level a description, because a label alone is unpickable', () => {
    for (const definition of ACTIVITY_LEVELS) {
      expect(definition.description.length).toBeGreaterThan(10);
      expect(definition.label.length).toBeGreaterThan(0);
    }
  });

  it('increases strictly with activity', () => {
    const multipliers = ACTIVITY_LEVELS.map((level) => level.multiplier);
    for (let index = 1; index < multipliers.length; index += 1) {
      expect(multipliers[index]!).toBeGreaterThan(multipliers[index - 1]!);
    }
  });

  it('refuses an unknown level rather than defaulting to one', () => {
    expect(() => activityMultiplier('athletic' as ActivityLevel)).toThrow(
      /Unknown activity level/,
    );
  });
});

describe('totalDailyEnergyExpenditure', () => {
  it.each(ACTIVITY_LEVELS)('scales BMR by the $level multiplier', (definition) => {
    expect(totalDailyEnergyExpenditure(1780, definition.level)).toBeCloseTo(
      1780 * definition.multiplier,
      6,
    );
  });

  it('is the product, with no rounding applied on the way through', () => {
    // 1780 × 1.375 = 2447.5 — the half is carried, not lost, so rounding
    // happens once at the end rather than compounding at each step.
    expect(totalDailyEnergyExpenditure(1780, 'light')).toBe(2447.5);
  });
});

describe('rounding', () => {
  it.each([
    [2047, 2050],
    [2044, 2040],
    [2045, 2050],
    [1995, 2000],
    [0, 0],
  ])('rounds %s to %s', (input, expected) => {
    expect(roundCalories(input)).toBe(expected);
  });

  it('always lands on a multiple of the documented step', () => {
    for (let kcal = 800; kcal <= 5000; kcal += 7) {
      expect(roundCalories(kcal) % CALORIE_ROUNDING_STEP).toBe(0);
    }
  });
});

describe('capAdjustment', () => {
  it('leaves a conservative deficit alone at a normal maintenance', () => {
    expect(capAdjustment(-500, 2800)).toBe(-500);
  });

  /**
   * 500 kcal off a 1,600 kcal maintenance is 31%. The flat default is mild for
   * a large person and aggressive for a small one; capping the proportion is
   * what stops one number from meaning two things.
   */
  it('caps a deficit that is too large a share of maintenance', () => {
    expect(capAdjustment(-500, 1600)).toBe(-1600 * MAX_DEFICIT_FRACTION);
  });

  it('caps a surplus the same way', () => {
    expect(capAdjustment(2000, 1600)).toBe(1600 * MAX_SURPLUS_FRACTION);
  });

  it('leaves maintenance untouched', () => {
    expect(capAdjustment(0, 2400)).toBe(0);
  });
});

describe('calculateTargets', () => {
  const targetsFor = (direction: GoalDirection) =>
    calculateTargets(ADULT, 'moderate', direction)!;

  /* BMR 1780, moderate ×1.55 = 2759 maintenance. */
  it('reports maintenance separately from the suggested target', () => {
    const maintain = targetsFor('maintain');

    expect(maintain.tdee).toBeCloseTo(2759, 6);
    expect(maintain.calorieTarget).toBe(2760);
    expect(maintain.appliedAdjustment).toBe(0);
  });

  it('applies the conservative deficit for a loss', () => {
    const lose = targetsFor('lose');

    expect(lose.appliedAdjustment).toBe(CALORIE_ADJUSTMENTS.lose);
    expect(lose.calorieTarget).toBe(roundCalories(2759 - 500));
    // Maintenance is unchanged by the goal — it is a property of the person.
    expect(lose.tdee).toBeCloseTo(2759, 6);
  });

  it('applies the conservative surplus for a gain', () => {
    const gain = targetsFor('gain');

    expect(gain.appliedAdjustment).toBe(CALORIE_ADJUSTMENTS.gain);
    expect(gain.calorieTarget).toBe(roundCalories(2759 + 300));
  });

  it('orders the three directions', () => {
    expect(targetsFor('lose').calorieTarget).toBeLessThan(
      targetsFor('maintain').calorieTarget,
    );
    expect(targetsFor('gain').calorieTarget).toBeGreaterThan(
      targetsFor('maintain').calorieTarget,
    );
  });

  it('accepts an adjustment override in the calculation layer', () => {
    const custom = calculateTargets(ADULT, 'moderate', 'lose', {
      calorieAdjustment: -250,
    })!;
    expect(custom.appliedAdjustment).toBe(-250);
    expect(custom.calorieTarget).toBe(roundCalories(2759 - 250));
  });

  it('returns null rather than a number when the equation cannot run', () => {
    expect(calculateTargets({ ...ADULT, sex: 'unspecified' }, 'moderate', 'lose')).toBeNull();
    expect(calculateTargets({ ...ADULT, weightKg: 0 }, 'moderate', 'lose')).toBeNull();
  });
});

describe('the safety floor', () => {
  /** A small, sedentary person: the arithmetic alone lands below the floor. */
  const SMALL: BodyMetrics = {
    weightKg: 48,
    heightCm: 155,
    ageYears: 60,
    sex: 'female',
  };

  it('never recommends below the floor', () => {
    const result = calculateTargets(SMALL, 'sedentary', 'lose')!;

    expect(result.rawTarget).toBeLessThan(result.floor);
    expect(result.calorieTarget).toBeGreaterThanOrEqual(result.floor);
  });

  it('flags that the floor moved the recommendation, rather than hiding it', () => {
    const result = calculateTargets(SMALL, 'sedentary', 'lose')!;
    expect(result.floorApplied).toBe(true);
  });

  it('does not flag a target the arithmetic reached on its own', () => {
    const result = calculateTargets(ADULT, 'moderate', 'lose')!;
    expect(result.floorApplied).toBe(false);
  });

  it('keeps the unfloored figure so the UI can explain the difference', () => {
    const result = calculateTargets(SMALL, 'sedentary', 'lose')!;
    expect(result.rawTarget).toBeGreaterThan(0);
    expect(result.rawTarget).not.toBe(result.calorieTarget);
  });

  /**
   * For a large person the table figure is far below their resting rate, so
   * the personal floor is the one that binds. Both rules exist because neither
   * covers the other.
   */
  it('uses whichever floor is higher for this person', () => {
    expect(calorieFloorFor('female', null)).toBe(CALORIE_FLOOR_KCAL.female);
    expect(calorieFloorFor('female', 900)).toBe(CALORIE_FLOOR_KCAL.female);
    expect(calorieFloorFor('female', 1800)).toBe(1800);
    expect(calorieFloorFor('male', 1400)).toBe(CALORIE_FLOOR_KCAL.male);
  });

  it('never recommends below the person own resting rate', () => {
    for (const level of ACTIVITY_LEVELS) {
      const result = calculateTargets(SMALL, level.level, 'lose')!;
      expect(result.calorieTarget).toBeGreaterThanOrEqual(Math.round(result.bmr));
    }
  });
});

describe('macroTargets', () => {
  it('sets protein from body weight and the goal direction', () => {
    // 80 kg × 1.8 g/kg for a loss.
    expect(macroTargets(2260, 80, 'lose').protein_g).toBe(144);
    // 80 kg × 1.6 g/kg at maintenance.
    expect(macroTargets(2760, 80, 'maintain').protein_g).toBe(128);
  });

  it('sets fat as a share of the calorie target', () => {
    // 25% of 2000 kcal = 500 kcal ÷ 9 = 55.6 g.
    expect(macroTargets(2000, 80, 'maintain').fat_g).toBe(56);
  });

  it('gives carbohydrate whatever the other two leave', () => {
    const macros = macroTargets(2000, 80, 'maintain');
    const leftOver =
      2000 - macros.protein_g * KCAL_PER_GRAM.protein - macros.fat_g * KCAL_PER_GRAM.fat;

    expect(macros.carbohydrates_g).toBe(Math.round(leftOver / KCAL_PER_GRAM.carbohydrate));
  });

  it('reconciles with the calorie target to within a gram of rounding', () => {
    for (const direction of ['lose', 'maintain', 'gain'] as GoalDirection[]) {
      for (let weight = 45; weight <= 160; weight += 5) {
        for (let target = 1200; target <= 4000; target += 10) {
          const macros = macroTargets(target, weight, direction);
          expect(Math.abs(macroReconciliation(macros, target))).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('never produces a negative macro, however tight the target', () => {
    for (let weight = 45; weight <= 200; weight += 5) {
      for (let target = 800; target <= 1600; target += 10) {
        const macros = macroTargets(target, weight, 'lose');
        expect(macros.protein_g).toBeGreaterThanOrEqual(0);
        expect(macros.carbohydrates_g).toBeGreaterThanOrEqual(0);
        expect(macros.fat_g).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * A heavy person on a low target: 200 kg × 1.8 g/kg of protein alone is
   * 1,440 kcal. Fat gives way first, then protein, and carbohydrate bottoms
   * out at zero rather than going negative.
   */
  it('holds fat at its floor and trims protein when the target is tight', () => {
    // 170 kg on 1,800 kcal: 1.8 g/kg of protein alone is 1,224 kcal, and
    // 0.5 g/kg of fat another 765 — 1,989 between them.
    const macros = macroTargets(1800, 170, 'lose');

    expect(macros.fat_g).toBe(Math.round(170 * MIN_FAT_G_PER_KG));
    expect(macros.protein_g).toBeLessThan(Math.round(170 * 1.8));
    expect(macros.protein_g).toBeGreaterThanOrEqual(Math.round(170 * MIN_PROTEIN_G_PER_KG));
    // Still reconciles: carbohydrate absorbs the remainder, half a gram either way.
    expect(Math.abs(macroReconciliation(macros, 1800))).toBeLessThanOrEqual(2);
  });

  it('leaves both alone when the target has room for them', () => {
    const macros = macroTargets(2800, 80, 'lose');

    expect(macros.protein_g).toBe(144);
    // The 25% share (78 g) is well above the 40 g floor here.
    expect(macros.fat_g).toBe(Math.round((2800 * 0.25) / 9));
    expect(macros.carbohydrates_g).toBeGreaterThan(0);
  });

  /**
   * Only reachable from a hand-entered target — the calculated path floors at
   * the person's resting rate. It still has to fit: three numbers that visibly
   * exceed the target printed above them are wrong on screen, whatever the
   * target's own merits.
   */
  it('still fits a target too small to hold both minimums', () => {
    const macros = macroTargets(1200, 160, 'lose');

    expect(macros.protein_g).toBeGreaterThan(0);
    expect(macros.fat_g).toBeGreaterThan(0);
    // Fits, rather than printing three numbers that exceed the target above them.
    expect(macroCalories(macros)).toBeLessThanOrEqual(1200);
    expect(1200 - macroCalories(macros)).toBeLessThanOrEqual(4);
    // Protein keeps the larger share, which is the point of the ordering.
    expect(macros.protein_g * 4).toBeGreaterThan(macros.fat_g * 9);
  });

  it('accepts overrides in the calculation layer', () => {
    const macros = macroTargets(2000, 80, 'maintain', {
      proteinGPerKg: 2.2,
      fatFraction: 0.35,
    });

    expect(macros.protein_g).toBe(176);
    expect(macros.fat_g).toBe(Math.round((2000 * 0.35) / 9));
  });

  it('adds macro calories up the way the labels say', () => {
    expect(macroCalories({ protein_g: 100, carbohydrates_g: 200, fat_g: 50 })).toBe(
      100 * 4 + 200 * 4 + 50 * 9,
    );
  });
});

describe('invariants', () => {
  const LEVELS = ACTIVITY_LEVELS.map((definition) => definition.level);

  it('BMR rises with weight, all else equal', () => {
    let previous = -Infinity;
    for (let weightKg = 45; weightKg <= 180; weightKg += 1) {
      const result = basalMetabolicRate({ ...ADULT, weightKg });
      expect(result.ok).toBe(true);
      const bmr = result.ok ? result.bmr : 0;
      expect(bmr).toBeGreaterThan(previous);
      previous = bmr;
    }
  });

  it('BMR rises with height, all else equal', () => {
    let previous = -Infinity;
    for (let heightCm = 145; heightCm <= 210; heightCm += 1) {
      const result = basalMetabolicRate({ ...ADULT, heightCm });
      const bmr = result.ok ? result.bmr : 0;
      expect(bmr).toBeGreaterThan(previous);
      previous = bmr;
    }
  });

  it('BMR falls with age, all else equal', () => {
    let previous = Infinity;
    for (let ageYears = 18; ageYears <= 90; ageYears += 1) {
      const result = basalMetabolicRate({ ...ADULT, ageYears });
      const bmr = result.ok ? result.bmr : 0;
      expect(bmr).toBeLessThan(previous);
      previous = bmr;
    }
  });

  it('TDEE rises with activity, for every body', () => {
    for (let weightKg = 50; weightKg <= 150; weightKg += 10) {
      const result = basalMetabolicRate({ ...ADULT, weightKg });
      const bmr = result.ok ? result.bmr : 0;

      let previous = -Infinity;
      for (const level of LEVELS) {
        const tdee = totalDailyEnergyExpenditure(bmr, level);
        expect(tdee).toBeGreaterThan(previous);
        previous = tdee;
      }
    }
  });

  it('a target never falls below the binding floor, across the whole input space', () => {
    for (const sex of ['male', 'female'] as const) {
      for (let weightKg = 40; weightKg <= 200; weightKg += 10) {
        for (let heightCm = 145; heightCm <= 210; heightCm += 5) {
          for (const level of LEVELS) {
            const result = calculateTargets(
              { weightKg, heightCm, ageYears: 45, sex },
              level,
              'lose',
            )!;
            expect(result.calorieTarget).toBeGreaterThanOrEqual(result.floor);
          }
        }
      }
    }
  });

  it('a deficit is never more than the documented share of maintenance', () => {
    for (let weightKg = 40; weightKg <= 200; weightKg += 10) {
      const result = calculateTargets(
        { weightKg, heightCm: 170, ageYears: 40, sex: 'female' },
        'sedentary',
        'lose',
      )!;
      expect(-result.appliedAdjustment).toBeLessThanOrEqual(
        result.tdee * MAX_DEFICIT_FRACTION + 1e-9,
      );
    }
  });
});

describe('goalProgress', () => {
  it('reports what is left', () => {
    expect(goalProgress(1500, 2000)).toMatchObject({
      remaining: 500,
      isOver: false,
      overBy: 0,
    });
  });

  /**
   * The bug this prevents: rendering −240 in a field labelled "remaining",
   * which reads as an allowance rather than as an overage.
   */
  it('reports an overage as an overage, not as a negative allowance', () => {
    const progress = goalProgress(2240, 2000);

    expect(progress.isOver).toBe(true);
    expect(progress.overBy).toBe(240);
    expect(progress.remaining).toBe(-240);
  });

  it('clamps the bar fraction at both ends', () => {
    expect(goalProgress(0, 2000).fraction).toBe(0);
    expect(goalProgress(4000, 2000).fraction).toBe(1);
    expect(goalProgress(1000, 2000).fraction).toBe(0.5);
  });

  it('does not divide by a target of zero', () => {
    expect(goalProgress(500, 0).fraction).toBe(0);
  });
});

describe('ageOn', () => {
  it('counts whole years', () => {
    expect(ageOn('1990-06-15', new Date('2026-06-15T12:00:00Z'))).toBe(36);
  });

  it('does not count a birthday that has not happened yet', () => {
    expect(ageOn('1990-06-16', new Date('2026-06-15T12:00:00Z'))).toBe(35);
  });

  it('handles a 29 February birth date in a common year', () => {
    expect(ageOn('2000-02-29', new Date('2026-02-28T12:00:00Z'))).toBe(25);
    expect(ageOn('2000-02-29', new Date('2026-03-01T12:00:00Z'))).toBe(26);
  });

  it('rejects a malformed or future date rather than returning a number', () => {
    expect(ageOn('not-a-date')).toBeNull();
    expect(ageOn('2030-01-01', new Date('2026-06-15T12:00:00Z'))).toBeNull();
  });
});
