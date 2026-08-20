/** Node stub for expo-crypto. See ./expo-sqlite.ts. */
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}
