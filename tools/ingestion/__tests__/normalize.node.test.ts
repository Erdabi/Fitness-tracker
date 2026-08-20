import {
  cleanName,
  hasValidCheckDigit,
  isPlausibleEnergy,
  isPlausibleMacros,
  normalizeBarcode,
  normalizeForSearch,
  parseBaseUnit,
  rescale,
  saltGramsToSodiumMg,
  toKcal,
  toOptionalNumber,
} from '../normalize';

describe('cleanName', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanName('  Greek   Yogurt \n')).toBe('Greek Yogurt');
  });

  it('preserves case for display', () => {
    expect(cleanName('Greek Yogurt')).toBe('Greek Yogurt');
  });

  it('strips control characters that corrupt exports', () => {
    // Real control characters, written as escapes so they survive editing.
    expect(cleanName('Yogurt\u0001')).toBe('Yogurt');
    expect(cleanName('Milk\u0000Chocolate')).toBe('Milk Chocolate');
    expect(cleanName('Tab\tSeparated')).toBe('Tab Separated');
  });
});

describe('normalizeForSearch', () => {
  /** The dedup guarantee: accents must not create a second record. */
  it('folds accents', () => {
    expect(normalizeForSearch('Crème Fraîche')).toBe('creme fraiche');
    expect(normalizeForSearch('Crème Fraîche')).toBe(normalizeForSearch('Creme Fraiche'));
  });

  it('lowercases and reduces punctuation to spaces', () => {
    expect(normalizeForSearch('Ben & Jerry’s: Cookie-Dough!')).toBe(
      'ben jerry s cookie dough',
    );
  });

  it('keeps digits and percent, which distinguish real products', () => {
    expect(normalizeForSearch('Milk 1.5% Fat')).toBe('milk 1 5% fat');
  });

  it('is idempotent', () => {
    const once = normalizeForSearch('Crème Fraîche 30%');
    expect(normalizeForSearch(once)).toBe(once);
  });

  it('handles an empty string', () => {
    expect(normalizeForSearch('   ')).toBe('');
  });
});

describe('normalizeBarcode', () => {
  it('keeps a valid EAN-13', () => {
    expect(normalizeBarcode('5000159484695')).toEqual({
      barcode: '5000159484695',
      format: 'ean13',
    });
  });

  /**
   * The same product scanned in the US and in Europe must resolve to one row.
   * UPC-A widened with a leading zero *is* the EAN-13.
   */
  it('widens UPC-A to EAN-13', () => {
    expect(normalizeBarcode('012345678905')).toEqual({
      barcode: '0012345678905',
      format: 'upca',
    });
  });

  it('strips separators', () => {
    expect(normalizeBarcode('5-000159-484695')?.barcode).toBe('5000159484695');
  });

  it('classifies EAN-8', () => {
    expect(normalizeBarcode('96385074')?.format).toBe('ean8');
  });

  it.each(['', '123', 'abcdefgh', '123456789012345678'])(
    'rejects %p as implausible',
    (input) => {
      expect(normalizeBarcode(input)).toBeNull();
    },
  );
});

describe('hasValidCheckDigit', () => {
  it.each(['5000159484695', '0012345678905', '96385074'])('accepts %s', (barcode) => {
    expect(hasValidCheckDigit(barcode)).toBe(true);
  });

  /**
   * A transposed digit is the classic data-entry error, and storing it would
   * occupy the real product's number while never matching a scan.
   */
  it('rejects a transposed digit', () => {
    expect(hasValidCheckDigit('5000159486495')).toBe(false);
  });

  it('rejects a wrong final digit', () => {
    expect(hasValidCheckDigit('5000159484694')).toBe(false);
  });

  it('rejects anything too short to carry one', () => {
    expect(hasValidCheckDigit('12345')).toBe(false);
  });
});

describe('toKcal', () => {
  it('passes kcal through', () => {
    expect(toKcal(250, 'kcal')).toBe(250);
    expect(toKcal(250, 'KCAL')).toBe(250);
  });

  it('converts kJ', () => {
    expect(toKcal(1000, 'kJ')).toBeCloseTo(239.006, 3);
  });

  it('returns null for an unknown unit rather than guessing', () => {
    expect(toKcal(250, 'furlongs')).toBeNull();
  });
});

describe('saltGramsToSodiumMg', () => {
  /** EU labels report salt; the app stores sodium. 1 g salt = 400 mg sodium. */
  it('converts using the standard 2.5 factor', () => {
    expect(saltGramsToSodiumMg(1)).toBe(400);
    expect(saltGramsToSodiumMg(0.5)).toBe(200);
  });
});

describe('parseBaseUnit', () => {
  it.each([
    ['g', 'g'],
    ['grams', 'g'],
    ['ml', 'ml'],
    ['millilitre', 'ml'],
    ['l', 'ml'],
    ['litre', 'ml'],
    ['piece', 'item'],
  ])('maps %s to %s', (input, expected) => {
    expect(parseBaseUnit(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'sploops'])('returns null for %p', (input) => {
    expect(parseBaseUnit(input)).toBeNull();
  });
});

describe('rescale', () => {
  it('rescales between bases', () => {
    expect(rescale(50, 100, 200)).toBe(100);
    expect(rescale(200, 250, 100)).toBe(80);
  });

  it('refuses a zero basis rather than returning Infinity', () => {
    expect(() => rescale(10, 0, 100)).toThrow();
  });
});

describe('plausibility', () => {
  /**
   * The failure this catches: kJ recorded in a kcal field, which would inflate
   * a day's total by a factor of four.
   */
  it('rejects energy above what pure fat can carry', () => {
    expect(isPlausibleEnergy(900)).toBe(true);
    expect(isPlausibleEnergy(1500)).toBe(false);
  });

  it('rejects negative and non-finite energy', () => {
    expect(isPlausibleEnergy(-1)).toBe(false);
    expect(isPlausibleEnergy(Number.NaN)).toBe(false);
  });

  it('rejects macros that exceed the mass they describe', () => {
    expect(isPlausibleMacros({ protein_g: 20, carbohydrates_g: 60, fat_g: 10 })).toBe(
      true,
    );
    expect(isPlausibleMacros({ protein_g: 60, carbohydrates_g: 60, fat_g: 60 })).toBe(
      false,
    );
  });

  it('allows a little slack for source rounding', () => {
    expect(isPlausibleMacros({ protein_g: 33, carbohydrates_g: 34, fat_g: 34 })).toBe(
      true,
    );
  });
});

describe('toOptionalNumber', () => {
  it('parses numbers and numeric strings', () => {
    expect(toOptionalNumber(12.5)).toBe(12.5);
    expect(toOptionalNumber(' 12.5 ')).toBe(12.5);
  });

  /**
   * "Missing" must never become 0. A food with no reported fibre is not a food
   * with zero fibre, and showing 0 g would be fabricated data.
   */
  it.each([null, undefined, '', 'NULL', 'n/a', Number.NaN, -5])(
    'returns null for %p rather than zero',
    (input) => {
      expect(toOptionalNumber(input)).toBeNull();
    },
  );

  it('keeps a genuine zero', () => {
    expect(toOptionalNumber(0)).toBe(0);
    expect(toOptionalNumber('0')).toBe(0);
  });
});
