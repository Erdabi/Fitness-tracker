import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXERCISE_CATALOGUE,
  catalogueSeedStatements,
} from '../exerciseCatalogue';

/**
 * The starter catalogue exists twice and must be identical.
 *
 * `src/lib/exerciseCatalogue.ts` seeds SQLite through migration v7;
 * `supabase/migrations/20260827000001_training.sql` seeds Postgres. They
 * cannot import each other — one runs on a phone, the other inside a database
 * — so nothing but this test keeps them in step.
 *
 * The consequence of drift is not cosmetic. A workout references a catalogue
 * exercise by id; if the two sides disagreed about ids, a session recorded on
 * a fresh device would be rejected by the server's foreign key and stop
 * syncing halfway through.
 */

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATION = readFileSync(
  join(ROOT, 'supabase/migrations/20260827000001_training.sql'),
  'utf8',
);

/** The seeded rows as the SQL file lists them, keyed by id. */
function serverCatalogue(): Map<string, { name: string; load: string; muscle: string }> {
  const start = MIGRATION.indexOf('insert into public.exercises\n  (id, owner_id');
  expect(start).toBeGreaterThan(-1);

  const block = MIGRATION.slice(start, MIGRATION.indexOf('on conflict (id) do nothing'));
  const rows = new Map<string, { name: string; load: string; muscle: string }>();

  // ('<id>', null, '<name>', '<normalized>', '<muscle>', …, '<load>', 'system', …
  const pattern =
    /\('([0-9a-f-]{36})',\s*null,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'([a-z_]+)',[\s\S]*?'(weighted|bodyweight|duration|distance)',\s*'system'/g;

  for (const match of block.matchAll(pattern)) {
    rows.set(match[1]!, {
      name: match[2]!.replace(/''/g, "'"),
      muscle: match[4]!,
      load: match[5]!,
    });
  }

  return rows;
}

describe('the starter catalogue', () => {
  const server = serverCatalogue();

  it('has the same number of exercises on both sides', () => {
    expect(server.size).toBe(EXERCISE_CATALOGUE.length);
  });

  it.each(EXERCISE_CATALOGUE.map((exercise) => [exercise.name, exercise] as const))(
    '%s exists server-side with the same id, name, muscle and load type',
    (_name, exercise) => {
      const remote = server.get(exercise.id);

      expect(remote).toBeDefined();
      expect(remote?.name).toBe(exercise.name);
      expect(remote?.muscle).toBe(exercise.primaryMuscle);
      expect(remote?.load).toBe(exercise.loadType);
    },
  );

  it('uses fixed ids rather than generating them', () => {
    // A generated id would differ per device, and a workout referencing one
    // would fail the server's foreign key.
    expect(MIGRATION).toContain("(id, owner_id, name");
    for (const exercise of EXERCISE_CATALOGUE) {
      expect(exercise.id).toMatch(/^e5e00000-0000-4000-8000-\d{12}$/);
    }
  });

  it('has no duplicate ids or names', () => {
    expect(new Set(EXERCISE_CATALOGUE.map((e) => e.id)).size).toBe(
      EXERCISE_CATALOGUE.length,
    );
    expect(new Set(EXERCISE_CATALOGUE.map((e) => e.normalizedName)).size).toBe(
      EXERCISE_CATALOGUE.length,
    );
  });

  it('covers every load type, so every set editor has something behind it', () => {
    const types = new Set(EXERCISE_CATALOGUE.map((exercise) => exercise.loadType));
    expect([...types].sort()).toEqual(['bodyweight', 'distance', 'duration', 'weighted']);
  });

  it('seeds every exercise as shared and system-sourced', () => {
    const statements = catalogueSeedStatements();
    expect(statements).toHaveLength(EXERCISE_CATALOGUE.length);

    for (const statement of statements) {
      // owner_id null and source 'system' is what makes it read-only.
      expect(statement).toContain('NULL,');
      expect(statement).toContain("'system'");
    }
  });

  it('seeds a fixed timestamp rather than the install time', () => {
    // A per-device timestamp would make the sync cursor behave differently on
    // every phone for no reason.
    const statements = catalogueSeedStatements();
    const stamps = statements.map((statement) =>
      /(\d{13}), (\d{13}), NULL, NULL/.exec(statement)?.[1],
    );

    expect(new Set(stamps).size).toBe(1);
    expect(stamps[0]).toBeDefined();
  });

  it('escapes an apostrophe rather than breaking the statement', () => {
    // "Farmer's Walk" is the obvious future addition that would break this.
    const seeded = catalogueSeedStatements().join('\n');
    const quotes = (seeded.match(/'/g) ?? []).length;
    expect(quotes % 2).toBe(0);
  });
});
