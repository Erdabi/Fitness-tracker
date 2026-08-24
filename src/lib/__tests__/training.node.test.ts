import {
  EPLEY_DIVISOR,
  MAX_REPS_FOR_1RM,
  bestOneRepMaxKg,
  describeDuration,
  describeSet,
  elapsedSeconds,
  estimatedOneRepMaxKg,
  formatDuration,
  formatLoad,
  fromCanonicalKg,
  reorder,
  reorderedPositions,
  setVolumeKg,
  summariseExercise,
  supportsOneRepMax,
  toCanonicalKg,
  totalVolumeKg,
  validateSet,
  type LoadType,
  type SetMeasurement,
} from '../training';

/**
 * Training arithmetic.
 *
 * Two things are being pinned down here more than any others: that kilograms
 * stay canonical across a round trip through a display unit, and that a metric
 * which does not apply comes back as null rather than as a zero somebody will
 * later average.
 */

const set = (overrides: Partial<SetMeasurement> = {}): SetMeasurement => ({
  weightKg: 70,
  reps: 8,
  durationSeconds: null,
  distanceM: null,
  isCompleted: true,
  ...overrides,
});

describe('canonical weight', () => {
  it('stores kilograms unchanged', () => {
    expect(toCanonicalKg(70, 'kg')).toBe(70);
  });

  it('converts pounds to kilograms on the way in', () => {
    expect(toCanonicalKg(155, 'lb')).toBeCloseTo(70.307, 3);
  });

  it('survives a round trip through the display unit', () => {
    // The user types 155 lb, it is stored as kg, and it reads back as 155 lb.
    const stored = toCanonicalKg(155, 'lb');
    expect(fromCanonicalKg(stored, 'lb')).toBe(155);
  });

  it('rounds display to a precision a gym can act on', () => {
    // Plates come in 1.25 kg steps; three decimals is noise.
    expect(fromCanonicalKg(70.30668, 'kg')).toBe(70.3);
  });

  it('formats no added weight as bodyweight, but only for bodyweight work', () => {
    expect(formatLoad(0, 'kg', 'bodyweight')).toBe('bodyweight');
    // Zero on a barbell is an unloaded bar, which is a real thing to record.
    expect(formatLoad(0, 'kg', 'weighted')).toBe('0 kg');
  });

  it('formats nothing at all when weight is not how the exercise is measured', () => {
    expect(formatLoad(null, 'kg', 'duration')).toBe('');
  });
});

describe('validateSet', () => {
  it('accepts an ordinary weighted set', () => {
    expect(validateSet({ ...set(), setNumber: 1 }, 'weighted')).toEqual([]);
  });

  it('refuses a negative weight', () => {
    const problems = validateSet({ ...set({ weightKg: -5 }) }, 'weighted');
    expect(problems.map((problem) => problem.field)).toContain('weightKg');
  });

  it('refuses negative or fractional reps', () => {
    expect(validateSet(set({ reps: -1 }), 'weighted')[0]?.field).toBe('reps');
    expect(validateSet(set({ reps: 8.5 }), 'weighted')[0]?.field).toBe('reps');
  });

  it('accepts zero reps, which is a set that was attempted and failed', () => {
    expect(validateSet(set({ reps: 0 }), 'weighted')).toEqual([]);
  });

  it('accepts zero weight on bodyweight work', () => {
    expect(validateSet(set({ weightKg: 0, reps: 20 }), 'bodyweight')).toEqual([]);
  });

  it('catches a slipped decimal point', () => {
    const problems = validateSet(set({ weightKg: 7000 }), 'weighted');
    expect(problems[0]?.message).toMatch(/decimal/i);
  });

  it('requires reps on a weighted set', () => {
    const problems = validateSet(set({ reps: null }), 'weighted');
    expect(problems.map((problem) => problem.field)).toContain('reps');
  });

  it('requires a duration on a held set, not reps', () => {
    const problems = validateSet(
      set({ weightKg: null, reps: null, durationSeconds: null }),
      'duration',
    );
    expect(problems.map((problem) => problem.field)).toEqual(['durationSeconds']);
  });

  it('requires a distance on a distance set', () => {
    const problems = validateSet(
      set({ weightKg: null, reps: null, distanceM: null }),
      'distance',
    );
    expect(problems.map((problem) => problem.field)).toEqual(['distanceM']);
  });

  it('refuses a zero-second hold', () => {
    const problems = validateSet(
      set({ weightKg: null, reps: null, durationSeconds: 0 }),
      'duration',
    );
    expect(problems.map((problem) => problem.field)).toContain('durationSeconds');
  });

  it('numbers sets from one', () => {
    expect(validateSet({ ...set(), setNumber: 0 }, 'weighted')[0]?.field).toBe('setNumber');
  });

  it('does not report the same field twice', () => {
    const problems = validateSet({ ...set({ reps: -3 }) }, 'weighted');
    expect(problems.filter((problem) => problem.field === 'reps')).toHaveLength(1);
  });
});

describe('volume', () => {
  it('is weight times reps', () => {
    expect(setVolumeKg(set({ weightKg: 70, reps: 8 }), 'weighted')).toBe(560);
  });

  it('sums across sets', () => {
    const sets = [
      set({ weightKg: 60, reps: 10 }),
      set({ weightKg: 70, reps: 8 }),
      set({ weightKg: 70, reps: 8 }),
    ];
    expect(totalVolumeKg(sets, 'weighted')).toBe(1720);
  });

  it('excludes a set that was planned but not performed', () => {
    const sets = [set({ weightKg: 70, reps: 8 }), set({ isCompleted: false })];
    expect(totalVolumeKg(sets, 'weighted')).toBe(560);
  });

  it('is null for a held set rather than zero', () => {
    // Zero would chart a plank session as a rest day.
    expect(setVolumeKg(set({ weightKg: null, reps: null, durationSeconds: 45 }), 'duration'))
      .toBeNull();
    expect(totalVolumeKg([set({ durationSeconds: 45 })], 'duration')).toBeNull();
  });

  it('is zero for unloaded bodyweight work, which did happen', () => {
    expect(setVolumeKg(set({ weightKg: 0, reps: 20 }), 'bodyweight')).toBe(0);
  });

  it('counts the added load on a weighted bodyweight set', () => {
    // Added weight is real load even on a pull-up.
    expect(setVolumeKg(set({ weightKg: 10, reps: 8 }), 'bodyweight')).toBe(80);
  });

  it('is null when there is nothing at all to multiply', () => {
    expect(totalVolumeKg([], 'weighted')).toBeNull();
  });
});

describe('estimated one-rep max', () => {
  it('uses the stated Epley formula', () => {
    expect(EPLEY_DIVISOR).toBe(30);
    // 100 × (1 + 5/30) = 116.667 → 116.7
    expect(estimatedOneRepMaxKg(set({ weightKg: 100, reps: 5 }), 'weighted')).toBe(116.7);
  });

  it('returns the weight itself for a single rep', () => {
    expect(estimatedOneRepMaxKg(set({ weightKg: 140, reps: 1 }), 'weighted')).toBeCloseTo(144.7, 1);
  });

  it('refuses a rep count the formula was never fitted to', () => {
    expect(MAX_REPS_FOR_1RM).toBe(12);
    expect(estimatedOneRepMaxKg(set({ weightKg: 60, reps: 12 }), 'weighted')).not.toBeNull();
    expect(estimatedOneRepMaxKg(set({ weightKg: 60, reps: 13 }), 'weighted')).toBeNull();
  });

  it('does not apply to bodyweight work', () => {
    // 20 push-ups would otherwise compute a one-rep max of zero.
    expect(supportsOneRepMax('bodyweight')).toBe(false);
    expect(estimatedOneRepMaxKg(set({ weightKg: 0, reps: 20 }), 'bodyweight')).toBeNull();
  });

  it('does not apply even to a weighted pull-up', () => {
    // The load that matters includes a bodyweight this row does not carry.
    expect(estimatedOneRepMaxKg(set({ weightKg: 20, reps: 5 }), 'bodyweight')).toBeNull();
  });

  it('does not apply to held or distance work', () => {
    expect(supportsOneRepMax('duration')).toBe(false);
    expect(supportsOneRepMax('distance')).toBe(false);
    expect(estimatedOneRepMaxKg(set({ durationSeconds: 60 }), 'duration')).toBeNull();
  });

  it('ignores a set that was not performed', () => {
    expect(estimatedOneRepMaxKg(set({ isCompleted: false }), 'weighted')).toBeNull();
  });

  it('ignores an unloaded set', () => {
    expect(estimatedOneRepMaxKg(set({ weightKg: 0, reps: 5 }), 'weighted')).toBeNull();
  });

  it('takes the best across sets, which is not always the heaviest', () => {
    const sets = [
      set({ weightKg: 100, reps: 5 }), // 116.7
      set({ weightKg: 105, reps: 3 }), // 115.5 — heavier, lower estimate
    ];
    expect(bestOneRepMaxKg(sets, 'weighted')).toBe(116.7);
  });

  it('is null when no set supports one', () => {
    expect(bestOneRepMaxKg([set({ reps: 20 })], 'weighted')).toBeNull();
  });
});

describe('summariseExercise', () => {
  it('reports every metric that applies to weighted work', () => {
    const summary = summariseExercise(
      [
        set({ weightKg: 60, reps: 10 }),
        set({ weightKg: 70, reps: 8 }),
        set({ weightKg: 70, reps: 8, isCompleted: false }),
      ],
      'weighted',
    );

    expect(summary).toMatchObject({
      volumeKg: 1160,
      bestWeightKg: 70,
      bestReps: 10,
      completedSets: 2,
    });
    expect(summary.estimatedOneRepMaxKg).toBeCloseTo(88.7, 1);
  });

  it('reports a hold as a duration and nothing else', () => {
    const summary = summariseExercise(
      [set({ weightKg: null, reps: null, durationSeconds: 45 })],
      'duration',
    );

    expect(summary.bestDurationSeconds).toBe(45);
    expect(summary.volumeKg).toBeNull();
    expect(summary.bestReps).toBeNull();
    expect(summary.estimatedOneRepMaxKg).toBeNull();
  });

  it('reports a run as a distance and nothing else', () => {
    const summary = summariseExercise(
      [set({ weightKg: null, reps: null, distanceM: 5000, durationSeconds: 1500 })],
      'distance',
    );

    expect(summary.bestDistanceM).toBe(5000);
    expect(summary.bestDurationSeconds).toBe(1500);
    expect(summary.estimatedOneRepMaxKg).toBeNull();
    expect(summary.bestReps).toBeNull();
  });

  it('counts only what was actually performed', () => {
    const summary = summariseExercise([set({ isCompleted: false })], 'weighted');
    expect(summary.completedSets).toBe(0);
    expect(summary.bestWeightKg).toBeNull();
  });
});

describe('reorder', () => {
  it('moves an item down the list', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves an item up the list', () => {
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the list alone for a no-op move', () => {
    expect(reorder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('treats a drag that ends outside the list as cancelled', () => {
    expect(reorder(['a', 'b', 'c'], 0, 9)).toEqual(['a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], -1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('renumbers densely from zero, leaving no gaps', () => {
    expect(reorderedPositions(['a', 'b', 'c'], 2, 0)).toEqual([
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ]);
  });

  it('never returns a duplicate position', () => {
    const positions = reorderedPositions(['a', 'b', 'c', 'd'], 1, 3);
    expect(new Set(positions.map((entry) => entry.position)).size).toBe(4);
  });
});

describe('duration', () => {
  it('counts elapsed seconds', () => {
    expect(elapsedSeconds(1000, 1000 + 65_000)).toBe(65);
  });

  it('floors at zero when the clock is corrected backwards', () => {
    expect(elapsedSeconds(2000, 1000)).toBe(0);
  });

  it('formats below and above an hour', () => {
    expect(formatDuration(249)).toBe('4:09');
    expect(formatDuration(3849)).toBe('1:04:09');
    expect(formatDuration(0)).toBe('0:00');
  });

  it('spells itself out for a screen reader', () => {
    // "4:09" is read as "four hundred nine" by some readers.
    expect(describeDuration(249)).toBe('4 minutes 9 seconds');
    expect(describeDuration(3600)).toBe('1 hour');
    expect(describeDuration(0)).toBe('0 seconds');
  });
});

describe('describeSet', () => {
  it('avoids the multiplication sign, which readers skip', () => {
    expect(describeSet(set({ weightKg: 70, reps: 8 }), 'weighted', 'kg')).toBe(
      '70 kilograms, 8 reps, done',
    );
  });

  it('says bodyweight rather than zero kilograms', () => {
    expect(describeSet(set({ weightKg: 0, reps: 20 }), 'bodyweight', 'kg')).toBe(
      'bodyweight, 20 reps, done',
    );
  });

  it('reads a hold as a duration', () => {
    expect(
      describeSet(set({ weightKg: null, reps: null, durationSeconds: 45 }), 'duration', 'kg'),
    ).toBe('45 seconds, done');
  });

  it('distinguishes a set still to do', () => {
    expect(describeSet(set({ isCompleted: false }), 'weighted', 'kg')).toBe(
      '70 kilograms, 8 reps',
    );
  });

  it('reads in the unit the user types in', () => {
    const stored = toCanonicalKg(155, 'lb');
    expect(describeSet(set({ weightKg: stored, reps: 5 }), 'weighted', 'lb')).toBe(
      '155 pounds, 5 reps, done',
    );
  });
});

describe('load types are exhaustive', () => {
  it('every load type has a required measurement', () => {
    const types: LoadType[] = ['weighted', 'bodyweight', 'duration', 'distance'];
    for (const type of types) {
      // An empty set must always produce exactly one "what is missing" problem.
      const problems = validateSet(
        { weightKg: null, reps: null, durationSeconds: null, distanceM: null, isCompleted: false },
        type,
      );
      expect(problems).toHaveLength(1);
    }
  });
});
