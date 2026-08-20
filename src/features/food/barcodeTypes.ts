/**
 * Barcode symbologies the schema and scanner support.
 *
 * Kept separate from the ingestion types so `src/lib/search.ts` — which both
 * the app and the importer use — has no dependency on server-side tooling.
 */
export type BarcodeFormat = 'ean13' | 'ean8' | 'upca' | 'upce' | 'other';
