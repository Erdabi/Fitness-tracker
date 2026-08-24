import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two halves of the wire contract must stay identical.
 *
 * `src/features/ai/schemas.ts` and `supabase/functions/_shared/contract.ts`
 * describe the same JSON. They are separate files because the Edge Functions
 * run under Deno, which resolves neither this project's path aliases nor its
 * node_modules — so the server cannot import the client's copy.
 *
 * A mirror without a test is a bug waiting for a deployment. This reads both
 * files as text and compares the shapes they declare, so adding a field on one
 * side and forgetting the other fails here rather than in production as a
 * response the client refuses to parse.
 *
 * Read as text rather than imported on purpose: importing the Deno file would
 * mean resolving `npm:zod@…`, and the lint rule that forbids app code from
 * importing server code exists precisely so nothing in `src/` ever does.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const CLIENT = readFileSync(join(ROOT, 'src/features/ai/schemas.ts'), 'utf8');
const SERVER = readFileSync(
  join(ROOT, 'supabase/functions/_shared/contract.ts'),
  'utf8',
);

/**
 * The field names declared inside one `z.object({ … })` literal.
 *
 * Crude by design: a parser would drift from what it is checking, whereas this
 * fails loudly the moment the two files stop looking alike, which is exactly
 * the signal wanted.
 */
function objectFields(source: string, schemaName: string): string[] {
  const start = source.indexOf(`${schemaName} = z.object({`);
  if (start === -1) throw new Error(`${schemaName} not found`);

  const open = source.indexOf('{', start + schemaName.length);
  let depth = 0;
  let end = open;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }

  const body = source.slice(open + 1, end);

  // Only keys at the top level of this object; nested objects are checked by
  // their own schema, and comments are stripped first so prose cannot match.
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const fields: string[] = [];
  let nesting = 0;

  for (const line of withoutComments.split('\n')) {
    const key = nesting === 0 ? /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line) : null;
    if (key?.[1]) fields.push(key[1]);

    nesting += (line.match(/[({[]/g) ?? []).length;
    nesting -= (line.match(/[)}\]]/g) ?? []).length;
    if (nesting < 0) nesting = 0;
  }

  return fields.sort();
}

const MIRRORED_OBJECTS = [
  'energySchema',
  'labelNutrientsSchema',
  'labelExtractionSchema',
  'photoItemSchema',
  'mealEstimationSchema',
];

describe('AI wire contract', () => {
  it.each(MIRRORED_OBJECTS)('%s declares the same fields on both sides', (name) => {
    expect(objectFields(SERVER, name)).toEqual(objectFields(CLIENT, name));
  });

  it.each([
    ['confidenceSchema', "['high', 'medium', 'low']"],
    ['labelStatusSchema', "['success', 'needs_review', 'unable_to_extract']"],
    ['photoStatusSchema', "['success', 'needs_review', 'unable_to_determine']"],
  ])('%s has the same members on both sides', (name) => {
    expect(enumMembers(SERVER, name)).toEqual(enumMembers(CLIENT, name));
  });

  it('agrees on the barcode pattern', () => {
    const pattern = /\/\^\[0-9\]\{6,14\}\$\//;
    expect(pattern.test(CLIENT)).toBe(true);
    expect(pattern.test(SERVER)).toBe(true);
  });

  it('agrees on the item and warning caps', () => {
    expect(CLIENT).toContain('.max(12)');
    expect(SERVER).toContain('.max(12)');
    expect(CLIENT).toContain('.max(10)');
    expect(SERVER).toContain('.max(10)');
  });

  it('keeps every nullable nutrient nullable on both sides', () => {
    // If one side dropped `.nullable()`, a label with no fibre would fail
    // validation there and succeed here — a skew that only shows up on a
    // partially readable packet.
    const clientNullable = (CLIENT.match(/nullableNonNegative/g) ?? []).length;
    const serverNullable = (SERVER.match(/nullableNonNegative/g) ?? []).length;
    expect(serverNullable).toBe(clientNullable);
  });

  it('states that it is a mirror, so the next reader knows to update both', () => {
    expect(CLIENT).toMatch(/contract\.ts/);
    expect(SERVER).toMatch(/schemas\.ts/);
  });
});

function enumMembers(source: string, name: string): string[] {
  const match = new RegExp(`${name} = z\\.enum\\(\\[([^\\]]*)\\]`).exec(source);
  if (!match?.[1]) throw new Error(`${name} not found`);

  return match[1]
    .split(',')
    .map((member) => member.trim().replace(/['"]/g, ''))
    .filter(Boolean)
    .sort();
}
