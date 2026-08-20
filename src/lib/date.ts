/**
 * Day resolution.
 *
 * Every logged item belongs to a *calendar day in the user's timezone*, never
 * to a UTC day. A snack at 23:30 in Zurich belongs to that day, not to
 * tomorrow, and the answer must not change when the user flies somewhere else
 * — which is why the day is computed at write time and stored as a plain
 * `YYYY-MM-DD` string rather than derived from a timestamp on read.
 */

/** A calendar day in the user's local timezone, formatted `YYYY-MM-DD`. */
export type LocalDay = string & { readonly __brand: 'LocalDay' };

const LOCAL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDay(value: string): value is LocalDay {
  if (!LOCAL_DAY_PATTERN.test(value)) return false;
  // Reject impossible dates that still match the shape, e.g. 2026-02-31.
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

export function asLocalDay(value: string): LocalDay {
  if (!isLocalDay(value)) {
    throw new Error(`Not a valid calendar day: ${value}`);
  }
  return value;
}

/**
 * The calendar day `instant` falls on, in `timeZone`.
 *
 * Uses `en-CA` because it formats as `YYYY-MM-DD`, which avoids hand-rolling
 * padding and month arithmetic across timezone boundaries.
 */
export function localDayFor(instant: Date, timeZone: string): LocalDay {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return asLocalDay(formatted);
}

/** Today, in the user's timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): LocalDay {
  return localDayFor(now, timeZone);
}

/** Shifts a calendar day by whole days, staying in calendar space. */
export function addDays(day: LocalDay, delta: number): LocalDay {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return asLocalDay(shifted.toISOString().slice(0, 10));
}

/** Whole days from `from` to `to`. Positive when `to` is later. */
export function daysBetween(from: LocalDay, to: LocalDay): number {
  const parse = (day: LocalDay): number => {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * The instant at which `day` begins in `timeZone`.
 *
 * Needed when querying by a timestamp range rather than by the stored day, and
 * for scheduling day-boundary work such as streak rollover.
 *
 * Resolved by probing: format a guess back into the target zone and correct by
 * the observed offset. This handles DST transitions, including the days where
 * midnight itself does not exist, without a timezone database.
 */
export function startOfLocalDay(day: LocalDay, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offset = timeZoneOffsetMs(new Date(guess), timeZone);
  const corrected = new Date(guess - offset);
  // One correction pass is enough unless the guess landed on the far side of a
  // DST change, in which case re-resolving with the corrected offset fixes it.
  const secondOffset = timeZoneOffsetMs(corrected, timeZone);
  return secondOffset === offset ? corrected : new Date(guess - secondOffset);
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  // `hour` formats as 24 rather than 0 at midnight under hour12: false.
  const hour = lookup('hour') % 24;

  const asUtc = Date.UTC(
    lookup('year'),
    lookup('month') - 1,
    lookup('day'),
    hour,
    lookup('minute'),
    lookup('second'),
  );
  return asUtc - instant.getTime();
}

/** The hour of the day (0–23) that `instant` falls on in `timeZone`. */
export function localHourFor(instant: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return Number(formatted);
}

/**
 * The device's current timezone, falling back to UTC when unavailable.
 * Kept here so the fallback is defined in exactly one place.
 */
export function resolveDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * An instant that is guaranteed to fall inside `day` in `timeZone`.
 *
 * Needed when a user logs food onto a day other than today: the diary date is
 * the local day of the entry's instant, so moving the entry means moving the
 * instant, and "yesterday at the current time of day" is both arbitrary and
 * wrong for a meal.
 *
 * Midday rather than midnight. Midnight is the one local time that can fail to
 * exist (spring-forward zones skip it in a handful of places) and the one that
 * lands one second from the neighbouring day; noon has twelve hours of margin
 * on either side, which no DST shift comes close to. Twelve hours after the
 * start of the day is 11:00, 12:00 or 13:00 local depending on the transition,
 * and all three are unambiguously inside it.
 */
export function middayOfLocalDay(day: LocalDay, timeZone: string): Date {
  return new Date(startOfLocalDay(day, timeZone).getTime() + 12 * 60 * 60 * 1000);
}
