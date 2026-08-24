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
