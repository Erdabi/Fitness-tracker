import {
  addDays,
  asLocalDay,
  daysBetween,
  isLocalDay,
  localDayFor,
  startOfLocalDay,
  todayIn,
} from '../date';

describe('localDayFor', () => {
  /**
   * The bug this prevents: deriving the diary day from a UTC timestamp puts a
   * late-evening snack on tomorrow.
   */
  it('keeps a late-evening entry on the local day, not the UTC one', () => {
    // 22:30 UTC on 19 Aug is 00:30 on 20 Aug in Zurich (UTC+2 in summer).
    const instant = new Date('2026-08-19T22:30:00Z');

    expect(localDayFor(instant, 'Europe/Zurich')).toBe('2026-08-20');
    expect(localDayFor(instant, 'UTC')).toBe('2026-08-19');
  });

  it('handles zones behind UTC', () => {
    // 02:00 UTC on 20 Aug is still 19 Aug in New York.
    const instant = new Date('2026-08-20T02:00:00Z');
    expect(localDayFor(instant, 'America/New_York')).toBe('2026-08-19');
  });

  it('handles zones far ahead of UTC', () => {
    const instant = new Date('2026-08-19T13:00:00Z');
    expect(localDayFor(instant, 'Pacific/Auckland')).toBe('2026-08-20');
  });

  it('handles a half-hour offset', () => {
    const instant = new Date('2026-08-19T19:00:00Z');
    expect(localDayFor(instant, 'Asia/Kolkata')).toBe('2026-08-20');
  });

  it('is stable across the winter/summer offset change', () => {
    expect(localDayFor(new Date('2026-01-15T23:30:00Z'), 'Europe/Zurich')).toBe(
      '2026-01-16',
    );
    expect(localDayFor(new Date('2026-07-15T23:30:00Z'), 'Europe/Zurich')).toBe(
      '2026-07-16',
    );
  });
});

describe('isLocalDay', () => {
  it('accepts a well-formed day', () => {
    expect(isLocalDay('2026-08-19')).toBe(true);
  });

  it('rejects wrong shapes', () => {
    expect(isLocalDay('2026-8-19')).toBe(false);
    expect(isLocalDay('19-08-2026')).toBe(false);
    expect(isLocalDay('2026-08-19T00:00:00Z')).toBe(false);
    expect(isLocalDay('')).toBe(false);
  });

  it('rejects dates that match the shape but do not exist', () => {
    expect(isLocalDay('2026-02-31')).toBe(false);
    expect(isLocalDay('2026-13-01')).toBe(false);
    expect(isLocalDay('2025-02-29')).toBe(false);
  });

  it('accepts a real leap day', () => {
    expect(isLocalDay('2028-02-29')).toBe(true);
  });
});

describe('asLocalDay', () => {
  it('throws on invalid input rather than propagating a bad day', () => {
    expect(() => asLocalDay('nope')).toThrow();
  });
});

describe('addDays', () => {
  it('moves forward and backward', () => {
    expect(addDays(asLocalDay('2026-08-19'), 1)).toBe('2026-08-20');
    expect(addDays(asLocalDay('2026-08-19'), -1)).toBe('2026-08-18');
  });

  it('crosses month and year boundaries', () => {
    expect(addDays(asLocalDay('2026-08-31'), 1)).toBe('2026-09-01');
    expect(addDays(asLocalDay('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(asLocalDay('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('crosses a leap day', () => {
    expect(addDays(asLocalDay('2028-02-28'), 1)).toBe('2028-02-29');
  });

  /**
   * Calendar arithmetic must not be affected by DST: the day after 28 March
   * is the 29th regardless of the clock jumping an hour.
   */
  it('is unaffected by a DST transition', () => {
    expect(addDays(asLocalDay('2026-03-28'), 1)).toBe('2026-03-29');
    expect(addDays(asLocalDay('2026-10-24'), 1)).toBe('2026-10-25');
  });
});

describe('daysBetween', () => {
  it('counts forward and backward', () => {
    expect(daysBetween(asLocalDay('2026-08-19'), asLocalDay('2026-08-26'))).toBe(7);
    expect(daysBetween(asLocalDay('2026-08-26'), asLocalDay('2026-08-19'))).toBe(-7);
  });

  it('is zero for the same day', () => {
    expect(daysBetween(asLocalDay('2026-08-19'), asLocalDay('2026-08-19'))).toBe(0);
  });

  it('counts across a DST boundary as whole days', () => {
    // Contains the spring-forward transition; still 31 calendar days.
    expect(daysBetween(asLocalDay('2026-03-01'), asLocalDay('2026-04-01'))).toBe(31);
  });
});

describe('startOfLocalDay', () => {
  it('resolves midnight in the target zone', () => {
    const start = startOfLocalDay(asLocalDay('2026-08-19'), 'Europe/Zurich');
    // Zurich is UTC+2 in August, so local midnight is 22:00 the previous day.
    expect(start.toISOString()).toBe('2026-08-18T22:00:00.000Z');
  });

  it('resolves midnight in UTC', () => {
    const start = startOfLocalDay(asLocalDay('2026-08-19'), 'UTC');
    expect(start.toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  it('round-trips back to the same day', () => {
    for (const zone of ['Europe/Zurich', 'America/New_York', 'Pacific/Auckland']) {
      const day = asLocalDay('2026-08-19');
      expect(localDayFor(startOfLocalDay(day, zone), zone)).toBe(day);
    }
  });

  it('round-trips on a DST spring-forward day', () => {
    // In Zurich, 02:00 does not exist on 2026-03-29.
    const day = asLocalDay('2026-03-29');
    expect(localDayFor(startOfLocalDay(day, 'Europe/Zurich'), 'Europe/Zurich')).toBe(day);
  });

  it('round-trips on a DST fall-back day', () => {
    const day = asLocalDay('2026-10-25');
    expect(localDayFor(startOfLocalDay(day, 'Europe/Zurich'), 'Europe/Zurich')).toBe(day);
  });
});

describe('todayIn', () => {
  it('uses the supplied clock', () => {
    const now = new Date('2026-08-19T22:30:00Z');
    expect(todayIn('Europe/Zurich', now)).toBe('2026-08-20');
    expect(todayIn('UTC', now)).toBe('2026-08-19');
  });
});
