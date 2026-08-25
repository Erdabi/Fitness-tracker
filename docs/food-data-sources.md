# Food data sources: licensing and import

Two external databases populate the shared food catalogue. Their licences
differ in ways that affect the product, not just the paperwork — read this
before adding a third source or shipping the catalogue anywhere.

The obligations are also recorded in the `food_sources` table, so they travel
with the rows they apply to. A requirement documented only in a README is one
refactor away from being lost.

---

## USDA FoodData Central

| | |
|---|---|
| **Licence** | Public domain (a U.S. Government work) |
| **Attribution** | Not required |
| **Share-alike** | None |
| **Quality rank** | 100 — highest |
| **Download** | https://fdc.nal.usda.gov/download-datasets.html |
| **Good for** | Generic whole foods: oats, chicken breast, apples |

Laboratory-measured, carefully curated, and legally unencumbered. This is why
it outranks everything else and why USDA rows are imported with
`is_verified = true`.

USDA asks for a courtesy citation. It is not a licence condition, but it costs
nothing and we include it in the app's about screen:

> USDA Agricultural Research Service, FoodData Central, fdc.nal.usda.gov

**Which dataset:** *Foundation Foods* and *SR Legacy* are the highest-quality
generic foods and are small enough to import in minutes. *Branded Foods* is
much larger and duplicates a lot of Open Food Facts.

---

## Open Food Facts

| | |
|---|---|
| **Licence** | **ODbL-1.0** (Open Database License) |
| **Attribution** | **Required** |
| **Share-alike** | **Yes — applies to derived databases** |
| **Quality rank** | 70 |
| **Download** | https://world.openfoodfacts.org/data |
| **Good for** | Packaged products and barcodes, strong European coverage |

### What ODbL actually requires

Three obligations, and the second and third are the ones that catch people:

1. **Attribution.** Anywhere OFF-derived data is shown, the source must be
   credited. The exact string is stored in
   `food_sources.attribution_text` and must appear in the app — the about
   screen at minimum, and near any product view sourced from OFF:

   > Contains information from Open Food Facts, made available under the Open
   > Database License (ODbL).

2. **Share-alike on derived databases.** If we publish a database that is
   derived from OFF — an export, a public API serving OFF rows, a dataset
   handed to a partner — that derived database must also be ODbL. This does
   **not** infect the app's source code, and it does **not** apply to merely
   *using* the data to serve individual users.

3. **Keep it open.** Any publicly distributed derived database must be offered
   in a machine-readable form.

### Practical consequences for this app

- Serving a user their own diary entries is a *produced work*, not a derived
  database. Normal app use is fine.
- **Do not** offer a bulk export of the food catalogue without deciding the
  licence question first.
- **Do not** mix OFF rows into a dataset you intend to license differently.
  `foods.source_id` is what keeps the provenance separable — never drop it.
- If the ODbL obligations ever become inconvenient, the exit is to drop OFF
  rows and fall back to USDA plus user-created foods. That stays possible only
  while provenance is tracked per row.

**Data quality:** OFF is crowd-sourced. Expect missing nutrition, energy in kJ,
sodium reported as salt, and occasional nonsense values. The adapter rejects
implausible records rather than importing them — see
`tools/ingestion/sources/openfoodfacts.ts`.

---

## Source quality ranking

`food_sources.quality_rank` decides what may overwrite what. It is enforced by
the `guard_nutrition_quality()` trigger, so the rule holds regardless of which
importer, script or client is writing.

| Source | Rank | Why |
|---|---|---|
| `usda` | 100 | Laboratory-measured and curated |
| `openfoodfacts` | 70 | Crowd-sourced from real labels |
| `user` | 60 | Authoritative for its owner, unverified generally |
| `ai_estimated` | 10 | Derived from an image; never a measurement |

**A lower-ranked source can never replace a higher-ranked one.** An AI estimate
cannot overwrite a USDA measurement even if a bug tries. Verified by
`supabase/tests/food_rls.test.sql`.

---

## Running an import

Datasets are **not committed to this repository.** They are hundreds of
megabytes to tens of gigabytes, they change upstream, and vendoring them would
freeze a snapshot nobody remembers to refresh. The pipeline is the artefact;
the data is fetched.

### 1. Download an export

```bash
mkdir -p data   # already gitignored

# USDA Foundation Foods (small, high quality)
curl -L -o data/usda-foundation.zip \
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2025-04-24.zip'
unzip -o data/usda-foundation.zip -d data/

# Open Food Facts (large; the JSONL dump streams)
curl -L -o data/off-products.jsonl.gz \
  'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz'
```

Check the download pages for current filenames — they carry dates.

### 2. Dry run first

Validates the export and reports what *would* happen. Needs no credentials, so
you can check an export before anyone touches the service role key.

```bash
npx tsx scripts/import-foods.ts \
  --source usda --file data/FoodData_Central_foundation_food_json_2025-04-24.json \
  --key FoundationFoods --dry-run
```

### 3. Import

```bash
export SUPABASE_URL='https://<project-ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='<service role key>'

npx tsx scripts/import-foods.ts \
  --source usda --file data/FoodData_Central_foundation_food_json_2025-04-24.json \
  --key FoundationFoods

# Start with a slice of OFF rather than all of it
npx tsx scripts/import-foods.ts \
  --source openfoodfacts --file data/off-products.jsonl.gz --limit 50000
```

> **The service role key bypasses Row Level Security.** It exists only so the
> importer can write the shared catalogue, which has no write policy for
> ordinary users. Keep it in your shell or a secret manager — never in the
> repository, never in `app.config.cjs`, and never behind an `EXPO_PUBLIC_`
> prefix.

### Re-running is safe

Records are matched on `(source_id, external_id)`, which is a unique index. A
second run **updates** rather than duplicating, and skips rows the source has
not revised. Re-import freely as upstream data improves.

---

## Adding a source

1. Write an adapter in `tools/ingestion/sources/` implementing `SourceAdapter`.
   It converts one raw record into a `CanonicalFood`, or returns a rejection
   reason. It does not touch the database.
2. Add a row to `food_sources` in a new migration, with its licence,
   attribution and `quality_rank`.
3. Mirror the rank in `SOURCE_QUALITY` (`tools/ingestion/quality.ts`) — a test
   asserts the two agree.
4. Register it in `scripts/import-foods.ts`.
5. Test the adapter against **real malformed records**, not just clean ones.
   Every source has its own way of being wrong, and that is what the adapter
   exists to absorb.
6. Document the licence here.

The pipeline, deduplication and quality rules are shared, so an adapter is the
only new code a source needs.
