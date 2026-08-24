import { hasValidCheckDigit, normalizeBarcode } from '@/lib/search';
import type { BarcodeFormat } from '@/features/food/barcodeTypes';

/**
 * Barcode scan handling, as pure logic.
 *
 * The camera fires `onBarcodeScanned` continuously — every frame a code is
 * visible, which is tens of times a second. Without suppression that is tens
 * of navigations and tens of network lookups for one physical scan: a broken
 * UI, and a way to exhaust a rate limit by holding a phone still.
 *
 * Kept out of the component so it can be tested without a camera.
 */

/**
 * How long the same code stays suppressed.
 *
 * Long enough to cover the whole time a user holds the phone over a packet and
 * reads the result; short enough that deliberately re-scanning the same
 * product — a second yoghurt from the same multipack — still works.
 */
export const RESCAN_SUPPRESSION_MS = 3_000;

/**
 * Symbologies worth scanning for food.
 *
 * Verified against the installed expo-camera 57's `BarcodeType` union rather
 * than assumed: `ean13`, `ean8`, `upc_a` and `upc_e` are all present there.
 * QR and the 2D formats are deliberately excluded — they are not food product
 * codes, and scanning for them means a poster in the background can hijack a
 * scan of a packet.
 */
export const FOOD_BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e'] as const;

export type ScanReason = 'accepted' | 'duplicate' | 'invalid' | 'busy';

export interface ScanDecision {
  readonly accepted: boolean;
  /** Normalised to EAN-13 where applicable. Null when nothing usable was read. */
  readonly barcode: string | null;
  /** The symbology the normaliser resolved, for display and diagnostics. */
  readonly format: BarcodeFormat | null;
  readonly reason: ScanReason;
}

export interface ScanGateState {
  /** The last code accepted, and when. */
  readonly lastBarcode: string | null;
  readonly lastAt: number;
  /** True while a lookup is in flight. */
  readonly busy: boolean;
}

export const initialScanGate: ScanGateState = {
  lastBarcode: null,
  lastAt: 0,
  busy: false,
};

/**
 * Decides whether a raw scan event should be acted on.
 *
 * Four outcomes, each a different thing to tell the user: accepted, the same
 * code again, a code that is not a valid food barcode, and a scan arriving
 * while the previous lookup is still running.
 *
 * Normalisation happens here so a UPC-A scanned in a US shop and the EAN-13 of
 * the same product scanned in Europe suppress each other — they are the same
 * code, and treating them as different would let one physical scan through
 * twice.
 */
export function decideScan(
  raw: string,
  state: ScanGateState,
  now: number,
): ScanDecision {
  if (state.busy) {
    return { accepted: false, barcode: null, format: null, reason: 'busy' };
  }

  const normalized = normalizeBarcode(raw);

  /*
   * The check digit is what separates a real barcode from a misread. Scanners
   * do emit a wrong digit under bad light, and looking that up would return
   * nothing and blame the catalogue for a scanning fault.
   */
  if (!normalized || !hasValidCheckDigit(normalized.barcode)) {
    return { accepted: false, barcode: null, format: null, reason: 'invalid' };
  }

  if (
    state.lastBarcode === normalized.barcode &&
    now - state.lastAt < RESCAN_SUPPRESSION_MS
  ) {
    return {
      accepted: false,
      barcode: normalized.barcode,
      format: normalized.format,
      reason: 'duplicate',
    };
  }

  return {
    accepted: true,
    barcode: normalized.barcode,
    format: normalized.format,
    reason: 'accepted',
  };
}

/** The gate state after an accepted scan. */
export function afterAccepted(barcode: string, now: number): ScanGateState {
  return { lastBarcode: barcode, lastAt: now, busy: true };
}

/** The gate state once a lookup finishes, however it went. */
export function afterSettled(state: ScanGateState): ScanGateState {
  return { ...state, busy: false };
}
