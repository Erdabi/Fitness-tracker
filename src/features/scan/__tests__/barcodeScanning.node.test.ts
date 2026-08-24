import {
  FOOD_BARCODE_TYPES,
  RESCAN_SUPPRESSION_MS,
  afterAccepted,
  afterSettled,
  decideScan,
  initialScanGate,
} from '../barcodeScanning';

/**
 * Scan gating, without a camera.
 *
 * The camera fires this tens of times a second while a code is in frame, so
 * the interesting cases are all about what it refuses: the same code twice, a
 * misread, and anything arriving while a lookup is already running.
 */

// Real, check-digit-valid codes.
const COCA_COLA_EAN13 = '5449000000996';
const UPC_A = '012000001291'; // The same drink, US packaging.
const EAN_8 = '96385074';

describe('decideScan', () => {
  it('accepts a valid EAN-13', () => {
    const decision = decideScan(COCA_COLA_EAN13, initialScanGate, 1000);

    expect(decision).toEqual({
      accepted: true,
      barcode: COCA_COLA_EAN13,
      format: 'ean13',
      reason: 'accepted',
    });
  });

  it('accepts a valid EAN-8', () => {
    const decision = decideScan(EAN_8, initialScanGate, 1000);
    expect(decision.accepted).toBe(true);
    expect(decision.format).toBe('ean8');
  });

  it('widens UPC-A to EAN-13 so the same product resolves either way', () => {
    const decision = decideScan(UPC_A, initialScanGate, 1000);

    expect(decision.accepted).toBe(true);
    expect(decision.barcode).toBe(`0${UPC_A}`);
    expect(decision.barcode).toHaveLength(13);
    expect(decision.format).toBe('upca');
  });

  it('rejects a code whose check digit does not add up', () => {
    // The same code with the last digit changed: a plausible misread.
    const decision = decideScan('5449000000997', initialScanGate, 1000);

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('invalid');
    expect(decision.barcode).toBeNull();
  });

  it('rejects something that is not a barcode at all', () => {
    for (const raw of ['', 'https://example.com', '12', 'abcdefghij']) {
      expect(decideScan(raw, initialScanGate, 1000).reason).toBe('invalid');
    }
  });

  it('suppresses the same code while the user is still looking at the result', () => {
    const gate = afterSettled(afterAccepted(COCA_COLA_EAN13, 1000));

    const decision = decideScan(COCA_COLA_EAN13, gate, 1000 + RESCAN_SUPPRESSION_MS - 1);

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('duplicate');
    // Still reported, so the UI can say which code it is ignoring.
    expect(decision.barcode).toBe(COCA_COLA_EAN13);
  });

  it('allows the same code again once the suppression window has passed', () => {
    const gate = afterSettled(afterAccepted(COCA_COLA_EAN13, 1000));

    const decision = decideScan(COCA_COLA_EAN13, gate, 1000 + RESCAN_SUPPRESSION_MS);
    expect(decision.accepted).toBe(true);
  });

  it('does not suppress a different product scanned immediately after', () => {
    const gate = afterSettled(afterAccepted(COCA_COLA_EAN13, 1000));

    expect(decideScan(EAN_8, gate, 1001).accepted).toBe(true);
  });

  it('treats a UPC-A rescan of an EAN-13 as the same code', () => {
    // Normalisation happens before the comparison, so the two forms of one
    // product suppress each other rather than both being accepted.
    const gate = afterSettled(afterAccepted(`0${UPC_A}`, 1000));

    expect(decideScan(UPC_A, gate, 1200).reason).toBe('duplicate');
  });

  it('ignores everything while a lookup is in flight', () => {
    const busy = afterAccepted(COCA_COLA_EAN13, 1000);

    expect(busy.busy).toBe(true);
    // Even a different, perfectly valid code waits its turn: two overlapping
    // lookups would mean two navigations from one interaction.
    expect(decideScan(EAN_8, busy, 1001).reason).toBe('busy');
  });

  it('resumes after the lookup settles, however it went', () => {
    const settled = afterSettled(afterAccepted(COCA_COLA_EAN13, 1000));

    expect(settled.busy).toBe(false);
    expect(decideScan(EAN_8, settled, 1001).accepted).toBe(true);
  });
});

describe('FOOD_BARCODE_TYPES', () => {
  it('scans only for food product symbologies', () => {
    expect([...FOOD_BARCODE_TYPES]).toEqual(['ean13', 'ean8', 'upc_a', 'upc_e']);
  });

  it('does not scan for QR or other 2D codes', () => {
    // A QR code on a poster behind the shelf must not be able to hijack a scan.
    for (const type of ['qr', 'datamatrix', 'pdf417', 'aztec']) {
      expect(FOOD_BARCODE_TYPES as readonly string[]).not.toContain(type);
    }
  });
});
