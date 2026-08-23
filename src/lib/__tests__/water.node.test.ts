import {
  DEFAULT_TARGET_ML,
  MAX_TARGET_ML,
  MIN_TARGET_ML,
  ML_PER_KG_PER_DAY,
  QUICK_ADD_ML,
  RECOMMENDATION_RANGE,
  RECOMMENDATION_STEP_ML,
  describeWaterProgress,
  formatFlOz,
  formatLitres,
  formatWater,
  formatWaterAgainstTarget,
  recommendedWaterMl,
  waterProgress,
} from '../water';
import { flOzToMl, mlToFlOz } from '../units';

/**
 * Water arithmetic.
 *
 * The recommendation is a product heuristic, so what is worth pinning is not
 * the number but its properties: deterministic, bounded, monotone in weight,
 * and never absent. The display functions are pinned harder, because the whole
 * point of storing millilitres is that every unit a user sees is derived.
 */

describe('recommendedWaterMl', () => {
  it('scales with body weight', () => {
    // 70 kg × 35 ml = 2,450 → nearest 50.
    expect(recommendedWaterMl(70)).toBe(2450);
    expect(recommendedWaterMl(60)).toBe(2100);
  });

  it('lands on the documented step', () => {
    for (let kg = 25; kg <= 200; kg += 0.5) {
      expect(recommendedWaterMl(kg) % RECOMMENDATION_STEP_ML).toBe(0);
    }
  });

  it('stays inside the documented range whatever the weight', () => {
    for (let kg = 25; kg <= 400; kg += 1) {
      const target = recommendedWaterMl(kg);
      expect(target).toBeGreaterThanOrEqual(RECOMMENDATION_RANGE.min);
      expect(target).toBeLessThanOrEqual(RECOMMENDATION_RANGE.max);
    }
  });

  it('clamps at both ends rather than extrapolating', () => {
    expect(recommendedWaterMl(30)).toBe(RECOMMENDATION_RANGE.min);
    expect(recommendedWaterMl(300)).toBe(RECOMMENDATION_RANGE.max);
  });

  it('never decreases as weight increases', () => {
    let previous = 0;
    for (let kg = 25; kg <= 250; kg += 1) {
      const target = recommendedWaterMl(kg);
      expect(target).toBeGreaterThanOrEqual(previous);
      previous = target;
    }
  });

  it('is deterministic', () => {
    expect(recommendedWaterMl(72.4)).toBe(recommendedWaterMl(72.4));
  });

  /**
   * A dashboard that cannot suggest a starting target until the user has
   * weighed themselves is a dashboard that shows nothing on day one.
   */
  it('falls back to a plausible default when weight is unknown', () => {
    expect(recommendedWaterMl(null)).toBe(DEFAULT_TARGET_ML);
    expect(recommendedWaterMl(Number.NaN)).toBe(DEFAULT_TARGET_ML);
    expect(recommendedWaterMl(0)).toBe(DEFAULT_TARGET_ML);
    expect(recommendedWaterMl(-70)).toBe(DEFAULT_TARGET_ML);
  });

  it('uses the constant it documents', () => {
    // 80 kg sits inside the clamp, so the raw formula is visible here.
    expect(recommendedWaterMl(80)).toBe(
      Math.round((80 * ML_PER_KG_PER_DAY) / RECOMMENDATION_STEP_ML) *
        RECOMMENDATION_STEP_ML,
    );
  });
});

describe('quick-add amounts', () => {
  it('offers the documented set, ascending', () => {
    expect([...QUICK_ADD_ML]).toEqual([250, 500, 750, 1000]);
    expect([...QUICK_ADD_ML]).toEqual([...QUICK_ADD_ML].sort((a, b) => a - b));
  });

  it('are all valid entry amounts', () => {
    for (const amount of QUICK_ADD_ML) {
      expect(amount).toBeGreaterThan(0);
      expect(amount).toBeLessThanOrEqual(MAX_TARGET_ML);
    }
  });
});

describe('waterProgress', () => {
  it('reports what is left', () => {
    expect(waterProgress(1750, 2500)).toMatchObject({
      remaining: 750,
      isOver: false,
      overBy: 0,
    });
  });

  /**
   * The bug this prevents: showing "−300 ml remaining", which reads as
   * available allowance rather than as having gone past the target.
   */
  it('reports going over as an overage, not a negative remainder', () => {
    const progress = waterProgress(2800, 2500);

    expect(progress.isOver).toBe(true);
    expect(progress.overBy).toBe(300);
    expect(progress.remaining).toBe(-300);
  });

  it('clamps the bar fraction at both ends', () => {
    expect(waterProgress(0, 2500).fraction).toBe(0);
    expect(waterProgress(5000, 2500).fraction).toBe(1);
    expect(waterProgress(1250, 2500).fraction).toBe(0.5);
  });

  it('does not divide by a target of zero', () => {
    expect(waterProgress(500, 0).fraction).toBe(0);
  });
});

describe('display', () => {
  it('shows millilitres below a litre and litres above, in metric', () => {
    expect(formatWater(750, 'metric')).toBe('750 ml');
    expect(formatWater(1750, 'metric')).toBe('1.75 L');
    expect(formatWater(1000, 'metric')).toBe('1 L');
  });

  it('shows fluid ounces in imperial', () => {
    expect(formatWater(1750, 'imperial')).toBe('59 fl oz');
  });

  it('renders the consumed/target pair in one unit, never two', () => {
    expect(formatWaterAgainstTarget(1750, 2500, 'metric')).toBe('1.75 / 2.5 L');
    expect(formatWaterAgainstTarget(2800, 2500, 'metric')).toBe('2.8 / 2.5 L');
    expect(formatWaterAgainstTarget(750, 900, 'metric')).toBe('750 / 900 ml');
    expect(formatWaterAgainstTarget(1750, 2500, 'imperial')).toBe('59 / 85 fl oz');
  });

  it('words the two progress cases distinctly', () => {
    expect(describeWaterProgress(waterProgress(1750, 2500), 'metric')).toBe(
      '750 ml remaining',
    );
    expect(describeWaterProgress(waterProgress(2800, 2500), 'metric')).toBe(
      '+300 ml over goal',
    );
  });

  it('never renders a negative volume', () => {
    for (let consumed = 0; consumed <= 6000; consumed += 137) {
      const text = describeWaterProgress(waterProgress(consumed, 2500), 'metric');
      expect(text).not.toMatch(/-\d/);
    }
  });

  it('formats litres and ounces for the headline figures', () => {
    expect(formatLitres(1750)).toBe('1.75');
    expect(formatFlOz(1750)).toBe('59');
  });
});

describe('unit conversion round-trips', () => {
  it('returns a volume to within a millilitre of where it started', () => {
    for (let ml = 50; ml <= 5000; ml += 25) {
      expect(flOzToMl(mlToFlOz(ml))).toBeCloseTo(ml, 6);
    }
  });

  it('is approximately reversible through the display rounding', () => {
    // Display rounds to whole ounces, so half an ounce of drift is expected
    // and anything more would mean the conversion itself is wrong.
    for (let ml = 250; ml <= 4000; ml += 250) {
      const shown = Math.round(mlToFlOz(ml));
      expect(Math.abs(flOzToMl(shown) - ml)).toBeLessThanOrEqual(29.58 / 2 + 1e-9);
    }
  });

  it('agrees with the known anchor', () => {
    // One US fluid ounce is 29.5735… ml by definition.
    expect(flOzToMl(1)).toBeCloseTo(29.5735295625, 9);
  });
});

describe('documented bounds', () => {
  it('keeps the target range consistent with the database constraint', () => {
    expect(MIN_TARGET_ML).toBe(500);
    expect(MAX_TARGET_ML).toBe(10_000);
    expect(RECOMMENDATION_RANGE.min).toBeGreaterThanOrEqual(MIN_TARGET_ML);
    expect(RECOMMENDATION_RANGE.max).toBeLessThanOrEqual(MAX_TARGET_ML);
  });
});
