import {
  MIN_PASSWORD_LENGTH,
  scorePassword,
  signInSchema,
  signUpSchema,
} from '../validation';

describe('signUpSchema', () => {
  it('accepts a valid pair', () => {
    expect(
      signUpSchema.safeParse({ email: 'sam@example.com', password: 'longenough1' })
        .success,
    ).toBe(true);
  });

  it('trims and accepts a padded email', () => {
    const result = signUpSchema.safeParse({
      email: '  sam@example.com ',
      password: 'longenough1',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('sam@example.com');
  });

  it.each(['', 'no-at-sign', 'missing@tld', '@example.com'])(
    'rejects %p as an email',
    (email) => {
      expect(signUpSchema.safeParse({ email, password: 'longenough1' }).success).toBe(
        false,
      );
    },
  );

  it('rejects a password below the minimum', () => {
    expect(
      signUpSchema.safeParse({
        email: 'sam@example.com',
        password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1),
      }).success,
    ).toBe(false);
  });

  it('accepts a password exactly at the minimum', () => {
    expect(
      signUpSchema.safeParse({
        email: 'sam@example.com',
        password: 'a'.repeat(MIN_PASSWORD_LENGTH),
      }).success,
    ).toBe(true);
  });

  it('rejects a password past bcrypt’s 72-byte limit', () => {
    expect(
      signUpSchema.safeParse({ email: 'sam@example.com', password: 'a'.repeat(73) })
        .success,
    ).toBe(false);
  });
});

describe('signInSchema', () => {
  /**
   * Sign-in must not apply the length rule: an existing password may predate a
   * policy change, and telling someone their correct password is too short is
   * both wrong and impossible to act on.
   */
  it('accepts a short existing password', () => {
    expect(
      signInSchema.safeParse({ email: 'sam@example.com', password: 'old' }).success,
    ).toBe(true);
  });

  it('still requires a password to be present', () => {
    expect(
      signInSchema.safeParse({ email: 'sam@example.com', password: '' }).success,
    ).toBe(false);
  });
});

describe('scorePassword', () => {
  it('rates anything below the minimum as weak', () => {
    expect(scorePassword('short')).toBe('weak');
  });

  it('rewards length over symbol soup', () => {
    expect(scorePassword('correcthorsebatterystaple')).toBe('strong');
  });

  it('rates a short mixed password below a long simple one', () => {
    expect(scorePassword('Ab1!xyzq')).not.toBe('strong');
  });

  it('returns a defined rating for every input', () => {
    for (const password of ['', 'a', 'abcdefgh', 'Passw0rd!', 'a'.repeat(40)]) {
      expect(['weak', 'fair', 'strong']).toContain(scorePassword(password));
    }
  });
});
