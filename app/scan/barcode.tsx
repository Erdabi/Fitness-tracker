import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, Text } from '@/components/ui';
import { cacheFood, getCachedFoodByBarcode } from '@/db/repositories/foodRecents';
import { getDatabase } from '@/db/client';

import { lookupBarcode } from '@/features/food/searchService';
import {
  FOOD_BARCODE_TYPES,
  afterAccepted,
  afterSettled,
  decideScan,
  initialScanGate,
  type ScanGateState,
  type ScanReason,
} from '@/features/scan/barcodeScanning';
import type { FoodSearchResult } from '@/features/food/types';
import { logger } from '@/lib/logger';
import { useTheme } from '@/theme';

/**
 * Barcode scanning.
 *
 * `CameraView` fires `onBarcodeScanned` on every frame a code is visible —
 * tens of times a second. All of the suppression logic lives in
 * `decideScan`, which is pure and tested; this screen only holds the state it
 * needs and reacts to the decision.
 *
 * The gate is kept in a ref rather than in state so a scan event arriving
 * mid-render reads the current value. React state is asynchronous, and a
 * hundred-millisecond stale read here is a duplicate navigation.
 */
export default function BarcodeScanScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();

  const gate = useRef<ScanGateState>(initialScanGate);
  const [status, setStatus] = useState<'scanning' | 'looking-up' | 'not-found'>(
    'scanning',
  );
  const [lastReason, setLastReason] = useState<ScanReason | null>(null);
  const [missingBarcode, setMissingBarcode] = useState<string | null>(null);

  const handleScan = useCallback(
    (raw: string) => {
      const decision = decideScan(raw, gate.current, Date.now());

      if (!decision.accepted) {
        // Duplicates and busy are silent — they are the common case and
        // announcing them would make a working scanner look broken. An
        // invalid read is worth surfacing once.
        if (decision.reason === 'invalid') setLastReason('invalid');
        return;
      }

      const barcode = decision.barcode!;
      gate.current = afterAccepted(barcode, Date.now());
      setLastReason(null);
      setStatus('looking-up');

      void resolve(barcode)
        .then((found) => {
          if (found) {
            router.replace({ pathname: '/food/[id]', params: { id: found.foodId } });
            return;
          }
          setMissingBarcode(barcode);
          setStatus('not-found');
        })
        .finally(() => {
          gate.current = afterSettled(gate.current);
        });
    },
    [router],
  );

  if (!permission) {
    return <Screen><Text variant="body">Checking camera access…</Text></Screen>;
  }

  if (!permission.granted) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.md }}>
          <Text variant="displayMedium">Camera access</Text>
          <Text variant="body" color="secondary">
            {permission.canAskAgain
              ? 'Scanning a barcode needs the camera.'
              : 'Camera access is turned off for this app. You can turn it back on in Settings.'}
          </Text>

          {/*
            A refusal is not a dead end. Everything below works without the
            camera, and offering it here is the difference between a blocked
            feature and a slower one.
          */}
          {permission.canAskAgain ? (
            <Button label="Allow camera" onPress={() => void requestPermission()} />
          ) : null}
          <Button
            label="Search for the food instead"
            variant="secondary"
            onPress={() => router.replace('/food/search')}
          />
          <Button
            label="Enter it by hand"
            variant="secondary"
            onPress={() => router.replace('/food/custom')}
          />
          <Button label="Back" variant="ghost" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  if (status === 'not-found' && missingBarcode) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.md }}>
          <Text variant="displayMedium">Not in the database</Text>
          <Text variant="body" color="secondary">
            Barcode {missingBarcode} did not match anything. That is common for
            local and own-brand products.
          </Text>

          <Button
            label="Scan the nutrition label"
            onPress={() =>
              router.replace({ pathname: '/scan/label', params: { barcode: missingBarcode } })
            }
          />
          <Button
            label="Search by name"
            variant="secondary"
            onPress={() => router.replace('/food/search')}
          />
          <Button
            label="Enter it by hand"
            variant="secondary"
            onPress={() =>
              router.replace({ pathname: '/food/custom', params: { barcode: missingBarcode } })
            }
          />
          <Button
            label="Scan another barcode"
            variant="ghost"
            onPress={() => {
              setMissingBarcode(null);
              setStatus('scanning');
            }}
          />
        </View>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        // Only food symbologies. Including QR would let a poster in the
        // background hijack a scan of a packet.
        barcodeScannerSettings={{ barcodeTypes: [...FOOD_BARCODE_TYPES] }}
        onBarcodeScanned={
          status === 'looking-up' ? undefined : ({ data }) => handleScan(data)
        }
      />

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: theme.spacing.lg,
          gap: theme.spacing.sm,
          backgroundColor: theme.colors.scrim,
        }}
      >
        <Text
          variant="headline"
          color="onAccent"
          align="center"
          accessibilityLiveRegion="polite"
        >
          {status === 'looking-up'
            ? 'Looking it up…'
            : lastReason === 'invalid'
              ? 'That code could not be read — try again'
              : 'Point the camera at a barcode'}
        </Text>

        <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
      </View>
    </View>
  );
}

/**
 * Cache first, then the server.
 *
 * A barcode the user has scanned before resolves with no network at all, which
 * is what makes scanning work in a supermarket basement. Only an unknown code
 * goes out to the catalogue.
 */
async function resolve(barcode: string): Promise<FoodSearchResult | null> {
  const cached = getCachedFoodByBarcode(barcode, getDatabase());
  if (cached) return cached;

  const result = await lookupBarcode(barcode);
  if (!result.ok) {
    logger.warn('Barcode lookup failed', { reason: result.error.code });
    return null;
  }

  const found = result.value.result;
  if (found) {
    // Cache on a hit so the next scan of the same product is instant and
    // works offline.
    try {
      cacheFood(found, [], getDatabase(), barcode);
    } catch {
      // A cache miss costs offline availability, not correctness.
    }
  }

  return found;
}
