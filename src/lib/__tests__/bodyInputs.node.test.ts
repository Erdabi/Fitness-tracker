import {
  LIMITS,
  MACRO_TOLERANCE_KCAL,
  parseNumber,
  validateActivity,
  validateAge,
  validateCalorieTarget,
  validateGoalDirection,
  validateHeight,
  validateHeightFeetInches,
  validateMacroTargets,
  validateSex,
  validateWeight,
} from '../bodyInputs';
import { cmToFeetInches, feetInchesToCm, kgToLb, lbToKg } from '../units';

/**
 * The validation layer.
 *
 * Two jobs, and they pull in opposite directions: refuse inputs the equation
 * cannot mean anything for, and let every real adult through. The tests below
 * push on both ends.
 */

const ok = <T>(result: { ok: boolean }): result is { ok: true; value: T } => result.ok;

describe('parseNumber', () => {
  it('accepts a comma as the decimal separator', () => {
    expect(parseNumber('72,5')).toBe(72.5);
    expect(parseNumber('72.5')).toBe(72.5);
  });

  it('treats an empty field as absent rather than as zero', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
  });

  it('rejects text', () => {
    expect(parseNumber('heavy')).toBeNull();
    expect(parseNumber('12kg')).toBeNull();
  });
});

describe('validateWeight', () => {
  it('takes kilograms as typed in metric', () => {
    const result = validateWeight('80', 'metric');
    expect(ok(result) && result.value).toBe(80);
  });

  it('converts pounds to kilograms in imperial', () => {
    const result = validateWeight('176', 'imperial');
    expect(ok(result) && result.value).toBeCloseTo(lbToKg(176), 2);
  });

  /**
   * The mistake this catches: 176 typed into a field the app is reading as
   * kilograms. In imperial it is an ordinary weight; in metric it is a
   * different species.
   */
  it('rejects a pound figure typed into a metric field', () => {
    const result = validateWeight('420', 'metric');
    expect(result.ok).toBe(false);
  });

  it.each([
    ['0', 'metric'],
    ['-80', 'metric'],
    ['5', 'metric'],
    ['900', 'metric'],
    ['', 'metric'],
    ['heavy', 'metric'],
  ] as const)('rejects %s', (input, system) => {
    expect(validateWeight(input, system).ok).toBe(false);
  });

  it('accepts both ends of the supported range', () => {
    expect(validateWeight(String(LIMITS.weightKg.min), 'metric').ok).toBe(true);
    expect(validateWeight(String(LIMITS.weightKg.max), 'metric').ok).toBe(true);
    expect(validateWeight(String(LIMITS.weightKg.min - 1), 'metric').ok).toBe(false);
    expect(validateWeight(String(LIMITS.weightKg.max + 1), 'metric').ok).toBe(false);
  });

  it('names the field so the form can point at it', () => {
    const result = validateWeight('5', 'metric');
    expect(!result.ok && result.errors[0]!.field).toBe('weightKg');
  });
});

describe('validateHeight', () => {
  it('takes centimetres in metric', () => {
    const result = validateHeight({ cm: '180' }, 'metric');
    expect(ok(result) && result.value).toBe(180);
  });

  it('takes feet and inches in imperial', () => {
    const result = validateHeight({ feet: '5', inches: '11' }, 'imperial');
    expect(ok(result) && result.value).toBeCloseTo(feetInchesToCm({ feet: 5, inches: 11 }), 1);
  });

  it('treats a blank inches field as zero, not as missing', () => {
    const result = validateHeightFeetInches('6', '');
    expect(ok(result) && result.value).toBeCloseTo(182.88, 1);
  });

  /**
   * Two fields rather than one because "5.9" is ambiguous — five foot nine, or
   * five and nine tenths of a foot — and the app should not guess about
   * somebody's own body.
   */
  it('rejects an inches value that should have been a foot', () => {
    expect(validateHeightFeetInches('5', '13').ok).toBe(false);
    expect(validateHeightFeetInches('5', '12').ok).toBe(false);
    expect(validateHeightFeetInches('5', '11').ok).toBe(true);
  });

  it('rejects heights outside the supported range', () => {
    expect(validateHeight({ cm: '60' }, 'metric').ok).toBe(false);
    expect(validateHeight({ cm: '300' }, 'metric').ok).toBe(false);
    expect(validateHeight({ feet: '2', inches: '0' }, 'imperial').ok).toBe(false);
  });
});

describe('unit round-trips', () => {
  /** Conversion is lossy in the last decimal; it must not be lossy in the first. */
  it('returns a weight to within a gram of where it started', () => {
    for (let kg = 25; kg <= 400; kg += 0.5) {
      expect(lbToKg(kgToLb(kg))).toBeCloseTo(kg, 6);
    }
  });

  it('returns a height to within a rounded inch of where it started', () => {
    for (let cm = 100; cm <= 250; cm += 1) {
      const roundTripped = feetInchesToCm(cmToFeetInches(cm));
      // cmToFeetInches rounds to whole inches for display, so half an inch of
      // drift is expected and anything more is a bug.
      expect(Math.abs(roundTripped - cm)).toBeLessThanOrEqual(2.54 / 2 + 1e-9);
    }
  });

  it('survives a metric → imperial → metric trip through validation', () => {
    for (let kg = 45; kg <= 160; kg += 5) {
      const asPounds = String(kgToLb(kg));
      const result = validateWeight(asPounds, 'imperial');
      expect(ok(result) && Math.abs(result.value - kg)).toBeLessThan(0.01);
    }
  });

  it('never carries an inches value of 12 out of a conversion', () => {
    for (let cm = 100; cm <= 250; cm += 0.37) {
      expect(cmToFeetInches(cm).inches).toBeLessThan(12);
    }
  });
});

describe('validateAge', () => {
  it('accepts a whole number of years', () => {
    const result = validateAge('30');
    expect(ok(result) && result.value).toBe(30);
  });

  it('rejects fractional years', () => {
    expect(validateAge('30.5').ok).toBe(false);
  });

  it('holds the supported bounds', () => {
    expect(validateAge(String(LIMITS.ageYears.min)).ok).toBe(true);
    expect(validateAge(String(LIMITS.ageYears.min - 1)).ok).toBe(false);
    expect(validateAge(String(LIMITS.ageYears.max)).ok).toBe(true);
    expect(validateAge(String(LIMITS.ageYears.max + 1)).ok).toBe(false);
  });
});

describe('categorical inputs', () => {
  it('accepts the two the equation has terms for', () => {
    expect(validateSex('male')).toEqual({ ok: true, value: 'male' });
    expect(validateSex('female')).toEqual({ ok: true, value: 'female' });
  });

  /**
   * Declining to answer is a real state, and the profile's "other" maps onto
   * it. What must not happen is a default being substituted further down —
   * `basalMetabolicRate` refuses instead.
   */
  it('carries "other" through as unspecified rather than rejecting the person', () => {
    expect(validateSex('other')).toEqual({ ok: true, value: 'unspecified' });
    expect(validateSex('unspecified')).toEqual({ ok: true, value: 'unspecified' });
  });

  it('rejects an absent or unknown value', () => {
    expect(validateSex(null).ok).toBe(false);
    expect(validateSex(undefined).ok).toBe(false);
    expect(validateSex('yes').ok).toBe(false);
  });

  it('accepts every documented activity level and nothing else', () => {
    for (const level of ['sedentary', 'light', 'moderate', 'very', 'extra']) {
      expect(validateActivity(level).ok).toBe(true);
    }
    expect(validateActivity('athletic').ok).toBe(false);
    expect(validateActivity(null).ok).toBe(false);
  });

  it('accepts the three goal directions and nothing else', () => {
    for (const direction of ['lose', 'maintain', 'gain']) {
      expect(validateGoalDirection(direction).ok).toBe(true);
    }
    expect(validateGoalDirection('bulk').ok).toBe(false);
  });
});

describe('validateCalorieTarget', () => {
  it('accepts a whole number in range', () => {
    const result = validateCalorieTarget('2200');
    expect(ok(result) && result.value).toBe(2200);
  });

  /**
   * The input bound and the recommendation floor are different rules. 900 is
   * an acceptable thing to type; whether the app will recommend it is decided
   * elsewhere, and conflating the two would either block a legitimate choice
   * or hide a warning.
   */
  it('accepts a figure below the recommendation floor', () => {
    expect(validateCalorieTarget('900').ok).toBe(true);
  });

  it('rejects a figure below what the app supports at all', () => {
    expect(validateCalorieTarget(String(LIMITS.calorieTarget.min - 1)).ok).toBe(false);
    expect(validateCalorieTarget('0').ok).toBe(false);
    expect(validateCalorieTarget('-2000').ok).toBe(false);
  });

  it('rejects an implausibly high figure', () => {
    expect(validateCalorieTarget(String(LIMITS.calorieTarget.max + 1)).ok).toBe(false);
  });

  it('rejects fractions and text', () => {
    expect(validateCalorieTarget('2000.5').ok).toBe(false);
    expect(validateCalorieTarget('lots').ok).toBe(false);
  });
});

describe('validateMacroTargets', () => {
  it('accepts a set that adds up to the target', () => {
    // 150×4 + 200×4 + 67×9 = 600 + 800 + 603 = 2003.
    const result = validateMacroTargets(
      { protein: '150', carbohydrates: '200', fat: '67' },
      2000,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a set that adds up to a different target', () => {
    const result = validateMacroTargets(
      { protein: '150', carbohydrates: '400', fat: '67' },
      2000,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]!.message).toMatch(/above your 2000 kcal target/);
  });

  it('allows a tolerance nobody has to solve an equation to satisfy', () => {
    const withinTolerance = 2000 + MACRO_TOLERANCE_KCAL - 3;
    const carbs = (withinTolerance - 150 * 4 - 67 * 9) / 4;
    const result = validateMacroTargets(
      { protein: 150, carbohydrates: carbs, fat: 67 },
      2000,
    );
    expect(result.ok).toBe(true);
  });

  it('collects every field error in one pass', () => {
    const result = validateMacroTargets(
      { protein: 'x', carbohydrates: '-5', fat: '' },
      2000,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toHaveLength(3);
  });

  it('rejects negative and implausible grams', () => {
    expect(
      validateMacroTargets({ protein: '-1', carbohydrates: '200', fat: '67' }, 2000).ok,
    ).toBe(false);
    expect(
      validateMacroTargets({ protein: '900', carbohydrates: '200', fat: '67' }, 2000).ok,
    ).toBe(false);
  });
});
