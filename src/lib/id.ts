import * as Crypto from 'expo-crypto';

/**
 * Identifiers are generated on the device, not by the database.
 *
 * This is what makes offline writes possible: a row created with no connection
 * already has its final primary key, so it can be referenced by other local
 * rows immediately and pushed later without a remapping pass.
 */
export function newId(): string {
  return Crypto.randomUUID();
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
