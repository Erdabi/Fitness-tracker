import {
  cmToFeetInches,
  feetInchesToCm,
  flOzToMl,
  formatEnergy,
  formatHeight,
  formatVolume,
  formatWeight,
  kgToLb,
  lbToKg,
  mlToFlOz,
  round,
} from '../units';

describe('mass', () => {
  it('converts using the exact international pound', () => {
    expect(lbToKg(1)).toBeCloseTo(0.45359237, 8);
    expect(kgToLb(1)).toBeCloseTo(2.2046226, 6);
  });

  it('round-trips without drift', () => {
    for (const kg of [0.1, 1, 62.5, 100, 250]) {
      expect(lbToKg(kgToLb(kg))).toBeCloseTo(kg, 10);
    }
  });

  it('handles zero', () => {
    expect(lbToKg(0)).toBe(0);
    expect(kgToLb(0)).toBe(0);
  });
});

describe('length', () => {
  it('converts a known height', () => {
    // 5'10" is 177.8 cm exactly.
    expect(feetInchesToCm({ feet: 5, inches: 10 })).toBeCloseTo(177.8, 6);
  });

  /**
   * Displaying whole inches discards up to half an inch (1.27 cm), so an exact
   * round trip is impossible by construction. Asserting that bound is the
   * meaningful check — it catches a genuine conversion error while accepting
   * the precision the display format inherently costs.
   */
  it('round-trips feet and inches within the precision of whole inches', () => {
    const HALF_INCH_CM = 1.27;

    for (const cm of [150, 165.1, 177.8, 190]) {
      const { feet, inches } = cmToFeetInches(cm);
      expect(Math.abs(feetInchesToCm({ feet, inches }) - cm)).toBeLessThanOrEqual(
        HALF_INCH_CM + 1e-9,
      );
    }
  });

  /**
   * Rounding inches can reach exactly 12, which must carry into feet — a UI
   * showing 5' 12" is a visible bug.
   */
  it('carries 12 inches into the next foot', () => {
    // 182.85 cm is a hair under 6'0" and rounds up to 12 inches.
    const result = cmToFeetInches(182.85);
    expect(result.inches).toBeLessThan(12);
    expect(result).toEqual({ feet: 6, inches: 0 });
  });

  it('never reports 12 inches at any height', () => {
    for (let cm = 120; cm <= 220; cm += 0.05) {
      expect(cmToFeetInches(cm).inches).toBeLessThan(12);
    }
  });
});

describe('volume', () => {
  it('converts US fluid ounces', () => {
    expect(flOzToMl(1)).toBeCloseTo(29.5735, 4);
  });

  it('round-trips', () => {
    for (const ml of [100, 250, 500, 2500]) {
      expect(flOzToMl(mlToFlOz(ml))).toBeCloseTo(ml, 8);
    }
  });
});

describe('round', () => {
  it('rounds to the requested precision', () => {
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.2355, 2)).toBe(1.24);
    expect(round(1.5)).toBe(2);
  });

  it('rounds .5 up rather than down through float error', () => {
    // 1.005 is actually 1.00499999... in binary floating point.
    expect(round(1.005, 2)).toBe(1.01);
  });

  it('handles zero and negatives', () => {
    expect(round(0, 2)).toBe(0);
    expect(round(-1.235, 2)).toBe(-1.23);
  });
});

describe('formatting', () => {
  it('formats weight per system', () => {
    expect(formatWeight(80, 'metric')).toBe('80 kg');
    expect(formatWeight(80, 'imperial')).toBe('176.4 lb');
  });

  it('formats height per system', () => {
    expect(formatHeight(178, 'metric')).toBe('178 cm');
    expect(formatHeight(177.8, 'imperial')).toBe('5′ 10″');
  });

  it('switches to litres above 1000 ml', () => {
    expect(formatVolume(500, 'metric')).toBe('500 ml');
    expect(formatVolume(2500, 'metric')).toBe('2.5 L');
  });

  it('formats volume in imperial', () => {
    expect(formatVolume(500, 'imperial')).toBe('17 fl oz');
  });

  it('formats energy as whole kcal', () => {
    expect(formatEnergy(2150.6)).toContain('2');
    expect(formatEnergy(2150.6)).toContain('kcal');
    expect(formatEnergy(0)).toBe('0 kcal');
  });
});
