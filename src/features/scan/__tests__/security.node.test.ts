import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The boundary between the app and the server, asserted mechanically.
 *
 * Every rule here is one a person could break by accident with a single
 * plausible-looking import, and none of them would fail a normal test — a
 * leaked key works perfectly until somebody reads the bundle. So they are
 * checked against the source tree itself rather than against behaviour.
 *
 * `eslint.config.js` also blocks the import direction with a
 * `no-restricted-imports` rule, so a violation fails lint with a named line as
 * well as failing here.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Every source file the mobile app actually ships. */
function appSources(): string[] {
  const files: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts')) files.push(path);
    }
  };

  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'app'));
  return files;
}

const SOURCES = appSources();
const named = (path: string) => relative(ROOT, path);

describe('secrets never reach the app', () => {
  it('has no Anthropic key anywhere in the shipped source', () => {
    // The real key format. A hard-coded one would be readable by anyone who
    // downloads the app, since a mobile bundle is not a secret.
    const keyPattern = /sk-ant-[A-Za-z0-9_-]{10,}/;

    for (const file of SOURCES) {
      expect({ file: named(file), leaked: keyPattern.test(readFileSync(file, 'utf8')) })
        .toEqual({ file: named(file), leaked: false });
    }
  });

  it('never reads an Anthropic key from app configuration', () => {
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      expect({ file: named(file), reads: /ANTHROPIC_API_KEY/.test(source) }).toEqual({
        file: named(file),
        reads: false,
      });
    }
  });

  it('never references a service-role key', () => {
    // The service-role key bypasses RLS entirely. It belongs to the Edge
    // Functions and nowhere else.
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      expect({ file: named(file), reads: /service_role|SERVICE_ROLE/.test(source) }).toEqual({
        file: named(file),
        reads: false,
      });
    }
  });

  it('names no model and carries no prompt in the app', () => {
    // If the app knew the model or the prompt, changing either would be an app
    // release. Both live server-side, with the key.
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      // Comments explain the arrangement; code must not encode it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      expect({ file: named(file), names: /claude-[a-z0-9-]*\d/.test(code) }).toEqual({
        file: named(file),
        names: false,
      });
    }
  });

  it('reaches Anthropic through no SDK of its own', () => {
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      expect({
        file: named(file),
        imports: /from ['"]@anthropic-ai\//.test(source),
      }).toEqual({ file: named(file), imports: false });
    }
  });

  it('makes no request to api.anthropic.com', () => {
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      expect({ file: named(file), calls: /api\.anthropic\.com/.test(source) }).toEqual({
        file: named(file),
        calls: false,
      });
    }
  });
});

describe('app code cannot import server code', () => {
  it('imports nothing from supabase/functions', () => {
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      expect({
        file: named(file),
        imports: /from ['"][^'"]*supabase\/functions/.test(source),
      }).toEqual({ file: named(file), imports: false });
    }
  });

  it('imports nothing from the ingestion tooling', () => {
    // The importer holds catalogue write credentials and bulk-write paths.
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8');
      expect({
        file: named(file),
        imports: /from ['"][^'"]*tools\/ingestion/.test(source),
      }).toEqual({ file: named(file), imports: false });
    }
  });

  it('is enforced by lint as well, so a violation fails the build', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');

    expect(config).toContain('no-restricted-imports');
    expect(config).toContain('supabase/functions');
    expect(config).toContain('tools/ingestion');
  });

  it('excludes the Deno runtime from the app typecheck', () => {
    const tsconfig = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('supabase/functions');
  });
});

describe('the Edge Functions keep the key server-side', () => {
  const shared = join(ROOT, 'supabase/functions/_shared');

  it('reads the key from the environment and never hard-codes one', () => {
    const source = readFileSync(join(shared, 'claude.ts'), 'utf8');

    expect(source).toContain("Deno.env.get('ANTHROPIC_API_KEY')");
    expect(/sk-ant-[A-Za-z0-9_-]{10,}/.test(source)).toBe(false);
  });

  it('authenticates the caller before doing any work', () => {
    for (const name of ['analyze-nutrition-label', 'analyze-food-photo']) {
      const source = readFileSync(
        join(ROOT, 'supabase/functions', name, 'index.ts'),
        'utf8',
      );

      const authenticateAt = source.indexOf('authenticate(');
      const analyzeAt = source.indexOf('analyzeImage(');

      expect(authenticateAt).toBeGreaterThan(-1);
      // Order matters: an unauthenticated request must not reach a paid call.
      expect(authenticateAt).toBeLessThan(analyzeAt);
    }
  });

  it('validates the image before spending anything on it', () => {
    for (const name of ['analyze-nutrition-label', 'analyze-food-photo']) {
      const source = readFileSync(
        join(ROOT, 'supabase/functions', name, 'index.ts'),
        'utf8',
      );

      expect(source.indexOf('validateImage(')).toBeLessThan(
        source.indexOf('analyzeImage('),
      );
    }
  });

  it('uses the service-role key only for the quota ledger', () => {
    const auth = readFileSync(join(shared, 'auth.ts'), 'utf8');
    expect(auth).toContain('SUPABASE_SERVICE_ROLE_KEY');

    for (const name of ['analyze-nutrition-label', 'analyze-food-photo']) {
      const source = readFileSync(
        join(ROOT, 'supabase/functions', name, 'index.ts'),
        'utf8',
      );
      // The function never builds a privileged client of its own.
      expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    }
  });

  it('logs no image bytes and no nutrition', () => {
    const respond = readFileSync(join(shared, 'respond.ts'), 'utf8');
    const code = respond.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\bdata\b\s*[,:]/);
    expect(code).not.toMatch(/base64/i);
  });
});

describe('the quota ledger is not writable by the client', () => {
  const migration = readFileSync(
    join(ROOT, 'supabase/migrations/20260826000001_ai_scan_requests.sql'),
    'utf8',
  );

  it('enables row-level security', () => {
    expect(migration).toMatch(/enable row level security/i);
  });

  it('grants only select to authenticated users', () => {
    // No insert policy and no insert grant: a client that could write its own
    // ledger rows could erase its own usage.
    expect(migration).toMatch(/grant select on .*ai_scan_requests to authenticated/i);
    expect(migration).not.toMatch(/grant insert[^;]*ai_scan_requests to authenticated/i);
    expect(migration).not.toMatch(/for insert/i);
  });

  it('never forces row-level security, which would lock out the owner', () => {
    expect(migration).not.toMatch(/force row level security/i);
  });
});

describe('the app bundle is checked, not just the source', () => {
  it('has a leak check that runs against the built bundle', () => {
    // Reading the source proves intent; reading the bundle proves outcome.
    // The script is the thing the release gate runs.
    const script = readFileSync(join(ROOT, 'scripts/check-bundle.sh'), 'utf8');

    expect(script).toContain('ANTHROPIC_API_KEY');
    expect(script).toContain('service_role');
    expect(script).toContain('sk-ant-');
  });

  it('is wired into the package scripts', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['check:bundle']).toBeDefined();
  });
});

/**
 * Architectural non-regressions.
 *
 * Section Q of Milestone 7 asks for these explicitly, and each one is a rule
 * that has already been broken once in this project's history or would be easy
 * to break by accident: a second sync engine, a second local-date
 * implementation, or FORCE ROW LEVEL SECURITY reintroduced by copying an older
 * migration.
 */
describe('one sync engine, one local-date rule', () => {
  it('has exactly one sync engine', () => {
    /*
     * An engine is a file that walks the registry *and* drains the outbox.
     * `outbox.ts` defines `claimReady` but does not decide what to send, and
     * a descriptor knows about one table; only an engine does both.
     */
    const engines = SOURCES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /SYNC_REGISTRY/.test(source) && /claimReady\(/.test(source);
    });

    expect(engines.map(named)).toEqual(['src/sync/engine.ts']);
  });

  it('routes every local write through the one outbox', () => {
    /*
     * A repository writing without `withOutbox` would be silent data loss on
     * any device closed before the next sync.
     *
     * `periods.ts` is the one deliberate exception and is named here rather
     * than excluded by a pattern, so adding a second exception is a decision
     * somebody has to write down. It rebuilds `effective_to`, which is
     * *derived* on both sides rather than authored — enqueueing it would push
     * a computed column straight back at the server as though the user had
     * edited it. The descriptor contract says so in as many words.
     */
    const DERIVED_ONLY = ['src/db/repositories/periods.ts'];

    const writers = SOURCES.filter(
      (file) =>
        /src\/db\/repositories\//.test(file) &&
        /db\.run\(\s*\n?\s*`\s*(INSERT|UPDATE)/i.test(readFileSync(file, 'utf8')),
    );

    expect(writers.length).toBeGreaterThan(3);

    for (const file of writers) {
      if (DERIVED_ONLY.includes(named(file))) continue;

      const source = readFileSync(file, 'utf8');
      expect({ file: named(file), usesOutbox: /withOutbox|insertRow|updateRow/.test(source) })
        .toEqual({ file: named(file), usesOutbox: true });
    }
  });

  it('keeps the one outbox-free writer to derived columns', () => {
    const source = readFileSync(join(ROOT, 'src/db/repositories/periods.ts'), 'utf8');

    // Only `effective_to`, and nothing that carries user intent.
    const assignments = [...source.matchAll(/SET\s+([a-z_]+)\s*=/gi)].map(
      (match) => match[1],
    );

    expect(new Set(assignments)).toEqual(new Set(['effective_to']));
    expect(source).not.toContain('withOutbox');
  });

  it('derives a local day in exactly one place', () => {
    // `localDayFor` is that place. A second implementation would disagree
    // about DST and about travel, silently and only for some users.
    const implementors = SOURCES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /export function localDayFor/.test(source);
    });

    expect(implementors.map(named)).toEqual(['src/lib/date.ts']);
  });

  it('never truncates a UTC timestamp into a diary day', () => {
    /*
     * The exact shortcut every milestone has forbidden by name.
     *
     * `src/lib/date.ts` is excluded because it is the one file doing calendar
     * arithmetic rather than instant arithmetic: `addDays` shifts a
     * `Date.UTC(y, m, d)` — a date with no time and no zone — so truncating it
     * is the correct operation and not a timezone bug. Everywhere else, the
     * value being truncated is an instant, and the result would be a UTC day
     * masquerading as the user's.
     */
    const CALENDAR_ARITHMETIC = ['src/lib/date.ts'];

    for (const file of SOURCES) {
      if (CALENDAR_ARITHMETIC.includes(named(file))) continue;

      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      expect({
        file: named(file),
        truncates: /toISOString\(\)\s*\.\s*slice\(0,\s*10\)/.test(code),
      }).toEqual({ file: named(file), truncates: false });
    }
  });

  it('shares one local-date resolver server-side too', () => {
    /*
     * Migrations are append-only, so a resolver that *existed* still appears
     * in the file that created it — `resolve_food_log_day` was created in
     * Milestone 4 and dropped in Milestone 5, and both statements are still on
     * disk. What matters is the schema that results: every resolver ever
     * created is either the shared one or explicitly dropped again.
     *
     * The live-database version of this — that every local-day trigger is
     * bound to `resolve_local_date` and that nothing else survives — is
     * asserted against a real PostgreSQL in `supabase/tests/water.test.sql`.
     * This is the cheap file-level guard that catches a second resolver being
     * *added*, before anyone runs the database suite.
     */
    const migrations = join(ROOT, 'supabase/migrations');
    const files = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const created = new Set<string>();

    for (const name of files) {
      const sql = readFileSync(join(migrations, name), 'utf8');

      for (const match of sql.matchAll(
        /create (?:or replace )?function public\.(resolve_\w+)\(/g,
      )) {
        created.add(match[1]!);
      }

      for (const match of sql.matchAll(/drop function public\.(resolve_\w+)\(/g)) {
        created.delete(match[1]!);
      }
    }

    expect([...created]).toEqual(['resolve_local_date']);
  });

});

describe('row-level security stays enabled and unforced', () => {
  it('reintroduces FORCE ROW LEVEL SECURITY nowhere', () => {
    const migrations = join(ROOT, 'supabase/migrations');

    for (const name of readdirSync(migrations).filter((file) => file.endsWith('.sql'))) {
      const sql = readFileSync(join(migrations, name), 'utf8').toLowerCase();
      // Forcing it locks the table owner out of its own tables, which breaks
      // migrations and the ingestion importer.
      expect({ migration: name, forces: /force row level security/.test(sql) }).toEqual({
        migration: name,
        forces: false,
      });
    }
  });

  it('enables it on every user-owned table it adds', () => {
    const training = readFileSync(
      join(ROOT, 'supabase/migrations/20260827000001_training.sql'),
      'utf8',
    );

    for (const table of ['exercises', 'workouts', 'workout_exercises', 'workout_sets']) {
      expect(training).toContain(`alter table public.${table}`);
      expect(training).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`),
      );
    }
  });
});
