import {
  advanceCursor,
  isExhausted,
  MAX_OUTBOX_ATTEMPTS,
  resolve,
  retryDelayMs,
} from '../merge';

describe('resolve', () => {
  it('keeps local edits that have not been pushed yet', () => {
    // The case that loses user data if it is wrong: a pull arrives between a
    // local edit and its push.
    expect(
      resolve({
        localUpdatedAt: 1_000,
        remoteUpdatedAt: 9_999_999,
        hasPendingLocalChange: true,
      }),
    ).toBe('keep-local');
  });

  it('accepts remote rows that do not exist locally', () => {
    expect(
      resolve({
        localUpdatedAt: null,
        remoteUpdatedAt: 1_000,
        hasPendingLocalChange: false,
      }),
    ).toBe('accept-remote');
  });

  it('accepts remote when it is newer', () => {
    expect(
      resolve({
        localUpdatedAt: 1_000,
        remoteUpdatedAt: 2_000,
        hasPendingLocalChange: false,
      }),
    ).toBe('accept-remote');
  });

  it('keeps local when it is newer', () => {
    expect(
      resolve({
        localUpdatedAt: 5_000,
        remoteUpdatedAt: 2_000,
        hasPendingLocalChange: false,
      }),
    ).toBe('keep-local');
  });

  it('keeps local on an exact tie, to avoid pointless re-renders', () => {
    expect(
      resolve({
        localUpdatedAt: 3_000,
        remoteUpdatedAt: 3_000,
        hasPendingLocalChange: false,
      }),
    ).toBe('keep-local');
  });

  it('prefers a pending local change even over a newer remote row', () => {
    expect(
      resolve({
        localUpdatedAt: 1,
        remoteUpdatedAt: Number.MAX_SAFE_INTEGER,
        hasPendingLocalChange: true,
      }),
    ).toBe('keep-local');
  });
});

describe('advanceCursor', () => {
  it('returns the latest timestamp from the batch', () => {
    expect(
      advanceCursor(null, [
        '2026-08-19T10:00:00Z',
        '2026-08-19T12:00:00Z',
        '2026-08-19T11:00:00Z',
      ]),
    ).toBe('2026-08-19T12:00:00Z');
  });

  it('never moves backwards', () => {
    expect(advanceCursor('2026-08-19T12:00:00Z', ['2026-08-19T09:00:00Z'])).toBe(
      '2026-08-19T12:00:00Z',
    );
  });

  it('compares instants, not strings', () => {
    // Same moment, different offsets. String comparison would pick the wrong
    // one and skip rows on the next pull.
    expect(advanceCursor('2026-08-19T12:00:00Z', ['2026-08-19T15:00:00+02:00'])).toBe(
      '2026-08-19T15:00:00+02:00',
    );
  });

  it('ignores nulls and unparseable values', () => {
    expect(advanceCursor('2026-08-19T10:00:00Z', [null, 'not-a-date'])).toBe(
      '2026-08-19T10:00:00Z',
    );
  });

  it('returns the existing cursor for an empty batch', () => {
    expect(advanceCursor('2026-08-19T10:00:00Z', [])).toBe('2026-08-19T10:00:00Z');
  });

  it('stays null when there is nothing to advance to', () => {
    expect(advanceCursor(null, [null])).toBeNull();
  });
});

describe('retryDelayMs', () => {
  it('grows exponentially', () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(3)).toBe(8_000);
  });

  it('caps so an outage cannot become a hot loop', () => {
    expect(retryDelayMs(50)).toBe(5 * 60_000);
  });

  it('handles a zero attempt count without going negative', () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0);
  });
});

describe('isExhausted', () => {
  it('abandons an entry only at the limit', () => {
    expect(isExhausted(MAX_OUTBOX_ATTEMPTS - 1)).toBe(false);
    expect(isExhausted(MAX_OUTBOX_ATTEMPTS)).toBe(true);
  });
});
