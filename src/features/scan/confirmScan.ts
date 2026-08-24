import { supabase } from '@/api/supabase';
import {
  createCustomFood,
  type CustomFoodSource,
} from '@/features/food/customFoodService';
import type { LoggedFood } from '@/db/repositories/foodLogs';
import type { BaseUnit, NutritionPerBase, Serving } from '@/lib/nutrition';
import type { AppError } from '@/lib/result';

/**
 * Turning a confirmed scan into something the diary can log.
 *
 * The one architectural decision in this file, and the reason it exists:
 *
 * **A scan does not need a catalogue row to be logged.** `food_logs` snapshots
 * the nutrition it was given and keeps `food_id` only as provenance — it is
 * nullable precisely so an entry survives its food being deleted. So a
 * confirmed scan can be written to the diary on a train with no signal, using
 * the same offline path as every other entry, and saving it to the catalogue
 * becomes an optional extra rather than a precondition.
 *
 * That is also why there is no second queue for any of this. Creating a
 * catalogue food is online-only (see `customFoodService`), and if it fails the
 * diary entry still happens with `foodId: null`. Nothing is left half-written
 * and nothing needs retrying in the background.
 */

export interface ScanCandidate {
  readonly name: string;
  readonly brandName: string | null;
  readonly baseUnit: BaseUnit;
  readonly baseAmount: number;
  /** Per `baseAmount` of `baseUnit`. */
  readonly nutrition: NutritionPerBase;
  readonly serving: Serving | null;
  readonly barcode: string | null;
}

export interface ConfirmScanInput {
  readonly candidate: ScanCandidate;
  readonly source: CustomFoodSource;
  /** Whether to also create a reusable food. Online only. */
  readonly saveToCatalogue: boolean;
}

export interface ConfirmScanOutcome {
  /** Ready to hand to `logFood`. `foodId` is null when nothing was created. */
  readonly food: LoggedFood;
  /**
   * Why the catalogue save failed, when one was asked for and did not happen.
   *
   * Reported rather than thrown: the diary entry is the thing the user asked
   * for, and failing it because a convenience feature failed would be the
   * wrong trade. The screen shows this as "logged, but not saved to your
   * foods".
   */
  readonly catalogueError: AppError | null;
}

export async function confirmScannedFood(
  input: ConfirmScanInput,
  client = supabase,
): Promise<ConfirmScanOutcome> {
  const base: LoggedFood = {
    foodId: null,
    name: input.candidate.name,
    brandName: input.candidate.brandName,
    sourceId: input.source,
    // Never verified. An owned food cannot be, and the database enforces it
    // as well — see `only_global_foods_are_verified`.
    isVerified: false,
    baseUnit: input.candidate.baseUnit,
    baseAmount: input.candidate.baseAmount,
  };

  if (!input.saveToCatalogue) return { food: base, catalogueError: null };

  const created = await createCustomFood(
    {
      name: input.candidate.name,
      brandName: input.candidate.brandName,
      baseUnit: input.candidate.baseUnit,
      baseAmount: input.candidate.baseAmount,
      nutrition: input.candidate.nutrition,
      servings: input.candidate.serving
        ? [
            {
              label: input.candidate.serving.label,
              amount: input.candidate.serving.amount,
              unit: input.candidate.serving.unit,
            },
          ]
        : undefined,
      barcode: input.candidate.barcode,
      source: input.source,
    },
    client,
  );

  if (!created.ok) return { food: base, catalogueError: created.error };

  return { food: { ...base, foodId: created.value.foodId }, catalogueError: null };
}
