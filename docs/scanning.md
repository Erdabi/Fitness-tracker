# Scanning: barcodes, nutrition labels and food photos

Three ways to get a food into the diary without typing it, and one rule that
governs all three: **nothing is written anywhere until the user has seen it and
confirmed it.**

---

## 1. The three routes

| Route               | What it does                                    | Needs a connection   | Reliability                        |
| ------------------- | ----------------------------------------------- | -------------------- | ---------------------------------- |
| **Barcode**         | Decodes a GTIN and looks it up in the catalogue | Only on a first scan | Exact — a barcode is an identifier |
| **Nutrition label** | Reads the printed panel from a photograph       | Yes                  | Good, but every value is reviewed  |
| **Food photo**      | Estimates items and portions from a photograph  | Yes                  | Estimates only, per item           |

They are separate entry points rather than one "scan something" button. Reading
a barcode, reading printed numbers off a panel and guessing a plate from its
appearance need different capture behaviour and produce results of very
different reliability. Asking which one the user means costs one tap and
removes an entire class of wrong answer.

Every route ends somewhere useful when it fails: search the catalogue, or enter
the food by hand (`app/food/custom.tsx`). There is no dead end.

---

## 2. Where the API key lives

```
 app (React Native)                Supabase Edge Function (Deno)      Anthropic
 ─────────────────────             ─────────────────────────────      ─────────
 getAIProvider()
   └─ edgeProvider.ts
        functions.invoke(name,  ──▶  authenticate(caller)
          { image })                 validate the image
                                     check the daily quota
                                     ANTHROPIC_API_KEY  ──────────────▶ messages.parse
                                     validate the response            ◀──
        ◀── validated JSON      ◀──  record the scan
```

The app knows the **name of a function** and nothing else. It has no API key,
no model name, no prompt and no provider SDK. Changing the model or the prompt
is a function deployment, not an app release.

This is enforced three ways, each independent of the others:

1. **`eslint.config.js`** — a `no-restricted-imports` rule stops anything under
   `src/` or `app/` importing `supabase/functions/**` or `tools/ingestion/**`.
   A violation fails lint with a named line.
2. **`src/features/scan/__tests__/security.node.test.ts`** — reads every
   shipped source file and asserts the absence of a key, a service-role
   reference, a model id, the Anthropic SDK and a direct endpoint. Also asserts
   the ordering inside each function: authenticate, then validate, then spend.
3. **`scripts/check-bundle.sh`** (`npm run check:bundle`) — exports a real
   Metro bundle and greps it. Reading the source proves intent; reading the
   bundle proves outcome. It searches both ASCII and UTF-16 (Hermes stores any
   string containing a non-ASCII character as UTF-16, so an ASCII-only grep
   would silently miss half the bundle).

The service-role key exists in exactly one place — `_shared/auth.ts`'s
`serviceClient()` — and is used for exactly one thing: writing the quota
ledger. Everything else runs as the caller, with RLS applied.

---

## 3. Images are never stored

`AIProvider` takes the image **bytes**, not a storage path:

```ts
interface ScanImage {
  data: string; // base64, no data: prefix
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteLength: number;
}
```

The Phase 0 sketch had a storage path so a scan could be re-run without
re-photographing. That was reconsidered: a bucket means storage RLS, a
retention policy and a cleanup job, all for photographs of people's food and
their kitchens. Sending the bytes means the image exists for the duration of
one request and is never written down — no bucket, nothing to leak, nothing to
purge.

The quota ledger (`ai_scan_requests`) stores a user id, an operation name, an
outcome, a byte count and a token count. It stores no image, no storage
reference, no product name and no nutrition; `ai_scans.test.sql` asserts that
by inspecting the column list, so adding one later fails the database gate.

Structured logging (`_shared/respond.ts`) never touches the image or the
extracted nutrition.

### Limits

|                  | Value                     | Enforced                                          |
| ---------------- | ------------------------- | ------------------------------------------------- |
| Max image        | 4 MB decoded              | Client (`image.ts`) **and** server (`limits.ts`)  |
| Max edge         | 1568 px                   | At capture, so a full-res bitmap is never decoded |
| Capture quality  | 0.7 JPEG                  | At capture                                        |
| Daily scans      | 60 per user, rolling 24 h | Server, via the ledger                            |
| Provider timeout | 60 s                      | Server                                            |

The client copy exists so a user finds out before uploading. The server copy
exists because a client limit is a suggestion — anyone with the anon key can
call the function directly.

The server also checks **magic bytes**, not just the declared media type: a PDF
or an ELF binary labelled `image/jpeg` is refused before it reaches a vision
model. Only the first 16 bytes are decoded to do it.

---

## 4. The wire contract, and its mirror

`src/features/ai/schemas.ts` is the canonical contract.
`supabase/functions/_shared/contract.ts` is a deliberate mirror, because Deno
resolves neither this project's path aliases nor its `node_modules`.

A mirror without a test is a bug waiting for a deployment, so
`aiContract.node.test.ts` reads both files as text and compares the field sets,
enum members, regex and caps. Adding a field on one side and forgetting the
other fails there rather than in production.

The contract is validated **twice**: server-side before responding, and again
on arrival. That is not redundant — the function and the app are separate
deployments, and a version skew should surface as a typed error rather than as
undefined fields halfway through a review screen.

### Null is not zero

Every optional nutrient is `number | null`, and null survives all the way to
the database.

> A missing nutrient silently becoming 0 is the single most damaging thing this
> pipeline could do: it is indistinguishable from a real zero, and it
> under-counts every total built on it forever after.

This is why `NormalizedLabel` carries a `missing` list: `nutrition` is
catalogue-shaped, so its four required macros fall back to 0 to satisfy the
type. That fallback must not reach a form field. A field the model could not
read renders **blank** and blocks saving until it is filled — with a real 0 if
the label really says 0.

---

## 5. Conversions the model is not asked to do

`src/features/ai/normalize.ts`. The model reads what is printed; this resolves
it.

- **kJ → kcal** at 4.184 kJ/kcal, only when kcal is not printed. A printed
  kcal always wins: it is what the manufacturer declared, and re-deriving it
  would introduce a rounding difference into a figure that was already right.
- **Salt → sodium** at 39.34 % by mass (sodium in NaCl), only when sodium is
  not printed. The EU prints salt, the US prints sodium; converting in one
  place means a product read in either market is comparable.
- **Per-serving → per 100** using the printed serving size. With no serving
  size the values are left alone and a _problem_ is reported — guessing a
  serving size would fabricate the very number the scaling depends on.

### The impossibility gate

`validateNutrients` refuses nutrition that cannot describe a real food:
absolute per-100 bounds (a misread decimal point), component-exceeds-parent
(saturates > fat, sugars > carbs), macros outweighing the food, and an energy
figure the macros cannot support.

It applies to **hand-typed values too**. The check is about physical
possibility, not about trusting the source, so there is no editor override.

Countable foods (`unit: 'item'`) are exempt from the per-100 ceilings: a whole
pizza legitimately exceeds 1,000 kcal "per 1 item".

---

## 6. Review is not optional

`requiresReview()` is true when the status is not `success` **or** the
confidence is `low`. Both mean the same thing to the UI: show it, but let
nothing be saved until the user has looked at every number.

- **Labels** — every field is editable. Blocking problems disable the save
  button and name the offending field.
- **Photos** — every item is independent, with its own confidence.
  Low-confidence items **start switched off**. A plate is usually one confident
  item and one guess; treating the plate as a single result would force the
  user to accept the guess in order to keep the confident part.
- Correcting a portion rescales that item's nutrition with it
  (`changeQuantity`), because the model's estimate of _what the food is_
  survives a correction to _how much of it there was_. Correcting a nutrient
  rebases the item onto the quantity currently in the box (`editNutrient`).

An empty item list is a legitimate, useful answer — it is what
`unable_to_determine` looks like. Forcing at least one item would make "I
cannot tell what this is" impossible to express, and the model would invent
something instead.

---

## 7. Provenance never launders

An AI estimate can never claim to be catalogue data.

|                                                | `source_id`    | `is_verified`  |
| ---------------------------------------------- | -------------- | -------------- |
| Typed by hand, or read off a label and checked | `user`         | always `false` |
| Estimated from a photograph                    | `ai_estimated` | always `false` |

The database enforces both independently of this code:
`user_foods_use_user_source` constrains an owned food to those two sources, and
`only_global_foods_are_verified` forbids `is_verified` on anything owned.

A scan never overwrites a trusted USDA or Open Food Facts row. It creates a
food the user owns, or — more often — no food at all.

---

## 8. Why there is no second queue

A confirmed scan does not need a catalogue row to be logged.

`food_logs.food_id` is nullable and carries provenance only; the entry
snapshots its own `basis_*` nutrition at the moment of logging. So a scan
confirmed on a train with no signal is written to SQLite through the ordinary
`createFoodLog` path, lands in the ordinary outbox, and syncs when the
connection comes back. Saving it as a reusable food is an **optional extra**
that happens over the network, and when it fails the diary entry is already
safe (`confirmScan.ts` reports `catalogueError` rather than throwing).

That is also why AI requests are not queued. An AI scan is a foreground action
somebody is watching; quietly retrying a paid request after they have walked
away is the wrong default. A failure surfaces immediately with a _Try again_
button.

Creating a **catalogue food** is the one online-only operation in the app. A
custom food lives in the shared catalogue schema, whose ids the diary's
snapshots reference for provenance; creating one locally and reconciling later
would mean either a second id space or a rewrite pass over `food_logs`.

---

## 9. Barcodes

`FOOD_BARCODE_TYPES` is `['ean13', 'ean8', 'upc_a', 'upc_e']`, verified against
the installed expo-camera 57 `BarcodeType` union rather than assumed. QR and
the other 2D formats are deliberately excluded — they are not food product
codes, and scanning for them means a poster behind the shelf can hijack a scan
of a packet.

`decideScan()` is pure and testable without a camera. The camera fires
`onBarcodeScanned` every frame a code is visible — tens of times a second — so
the gate is what makes one physical scan produce one lookup:

- **invalid** — fails the GS1 modulo-10 check digit. Scanners do emit a wrong
  digit in bad light, and looking that up would blame the catalogue for a
  scanning fault.
- **duplicate** — the same code within 3 s. Normalisation happens _before_ the
  comparison, so a UPC-A and the EAN-13 of the same product suppress each
  other.
- **busy** — a lookup is already in flight.
- **accepted** — everything else.

UPC-A is widened to EAN-13 with a leading zero, so a product scanned in the US
resolves to the same row as one scanned in Europe.

A scanned code is cached against the food (`food_cache.barcode`, migration v6),
so the second scan of the same packet resolves from the device with no network
at all — which is what makes scanning work in a supermarket basement.

---

## 10. Deploying the functions

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-…
supabase functions deploy analyze-nutrition-label
supabase functions deploy analyze-food-photo
supabase db push        # the ai_scan_requests ledger
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform.

---

## 11. What is and is not verified here

**Verified in this environment:**

- Every pure rule: contract validation, conversions, the impossibility gate,
  the draft/review logic, the scan gate, provenance, the offline log-and-sync
  path — 943 Jest tests across two projects.
- The database: 12 migrations applied to a real PostgreSQL 16, 350 SQL
  assertions including the quota ledger's RLS. Failure-injected — adding an
  INSERT policy to the ledger makes `verify-db.sh` exit 1.
- The bundle: exported for Android and grepped. Failure-injected — a probe key
  in either ASCII or UTF-16 makes `check-bundle.sh` exit 1.
- The drift test: failure-injected — a field added to one side of the contract
  fails it.
- Server-side image validation, exercised under the node Jest project because
  `_shared/images.ts` has no Deno globals.

**Not verified here, and why:**

- **A real camera.** There is no device and no camera in this environment. The
  scan gate, the permission states and the capture options are tested; the
  frames themselves are not.
- **A real Anthropic call.** No key, and it would be a paid request. The
  provider boundary is tested with stubs on both success and every failure
  path; the prompts and the `messages.parse` call are not executed.
- **The Deno runtime.** Deno is not installed. The functions' pure helpers run
  under Jest; the `Deno.serve` handlers, the auth client and the quota ledger
  writes are verified by reading, by the SQL suite, and against a deployed
  project.

Scanning has **not** been demonstrated working end to end against live
hardware and a live model. Everything up to and away from those two boundaries
has.
