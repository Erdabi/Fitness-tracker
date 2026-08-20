import { fireEvent, render, screen } from '@testing-library/react-native';

import type { FoodLogRow } from '@/db/schema';
import { ThemeProvider } from '@/theme';
import { asLocalDay } from '@/lib/date';
import { DayNavigator, describeDay, formatFullDay } from '../DayNavigator';
import { DayTotalsBar } from '../DayTotalsBar';
import { DiaryEntryRow, portionOf } from '../DiaryEntryRow';
import { MealSection } from '../MealSection';
import { SyncNotice } from '../SyncNotice';
import { defaultMealFor } from '../MealPicker';

function renderThemed(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const ENTRY: FoodLogRow = {
  id: 'log-1',
  user_id: 'user-1',
  food_id: 'food-apple',
  serving_id: null,
  meal: 'breakfast',
  logged_at: Date.parse('2026-06-15T06:00:00.000Z'),
  time_zone: 'Europe/Zurich',
  diary_date: '2026-06-15',
  quantity: 200,
  serving_label: 'g',
  serving_amount: 1,
  amount_in_base: 200,
  food_name: 'Apple, raw',
  brand_name: null,
  food_source_id: 'usda',
  food_is_verified: 1,
  basis_unit: 'g',
  basis_amount: 100,
  basis_calories: 52,
  basis_protein_g: 0.26,
  basis_carbohydrates_g: 13.81,
  basis_fat_g: 0.17,
  basis_fiber_g: 2.4,
  basis_sugar_g: null,
  basis_saturated_fat_g: null,
  basis_sodium_mg: null,
  calories: 104,
  protein_g: 0.52,
  carbohydrates_g: 27.62,
  fat_g: 0.34,
  fiber_g: 4.8,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
  note: null,
  created_at: 0,
  updated_at: 0,
  server_updated_at: null,
  deleted_at: null,
};

describe('portionOf', () => {
  it('reads a raw quantity as the amount and its unit', () => {
    expect(portionOf(ENTRY)).toBe('200 g');
  });

  /**
   * The label alone ("2 × 1 slice") leaves out the number that makes the entry
   * checkable against a packet.
   */
  it('shows the base-unit equivalent of a named portion', () => {
    expect(
      portionOf({
        ...ENTRY,
        quantity: 2,
        serving_label: '1 slice',
        serving_amount: 30,
        amount_in_base: 60,
      }),
    ).toBe('2 × 1 slice (60 g)');
  });
});

describe('DiaryEntryRow', () => {
  it('renders the snapshotted name and total, not a lookup', () => {
    renderThemed(<DiaryEntryRow entry={ENTRY} />);

    expect(screen.getByText('Apple, raw')).toBeTruthy();
    expect(screen.getByText('104')).toBeTruthy();
  });

  it('opens the entry when pressed', () => {
    const onPress = jest.fn();
    renderThemed(<DiaryEntryRow entry={ENTRY} onPress={onPress} />);

    fireEvent.press(screen.getByRole('button'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('MealSection', () => {
  const subtotal = {
    calories: 104,
    protein_g: 0.52,
    carbohydrates_g: 27.62,
    fat_g: 0.34,
    fiber_g: 4.8,
    sugar_g: null,
    saturated_fat_g: null,
    sodium_mg: null,
  };

  it('offers a way in even when the meal is empty', () => {
    const onAdd = jest.fn();
    renderThemed(
      <MealSection
        meal="lunch"
        entries={[]}
        subtotal={subtotal}
        onAdd={onAdd}
        onSelectEntry={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByText('Add lunch'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('shows the subtotal once the meal has entries', () => {
    renderThemed(
      <MealSection
        meal="breakfast"
        entries={[ENTRY]}
        subtotal={subtotal}
        onAdd={jest.fn()}
        onSelectEntry={jest.fn()}
      />,
    );

    expect(screen.getByText('104 kcal')).toBeTruthy();
    expect(screen.getByText('Add another')).toBeTruthy();
  });
});

describe('describeDay', () => {
  const today = asLocalDay('2026-06-15');

  it('names the two days that carry the traffic', () => {
    expect(describeDay(today, today)).toBe('Today');
    expect(describeDay(asLocalDay('2026-06-14'), today)).toBe('Yesterday');
  });

  it('uses weekday names for the rest of the week', () => {
    expect(describeDay(asLocalDay('2026-06-11'), today)).toBe('Thursday');
  });

  it('falls back to a date once a weekday stops being unambiguous', () => {
    const older = asLocalDay('2026-05-30');
    expect(describeDay(older, today)).toBe(formatFullDay(older));
  });
});

describe('DayNavigator', () => {
  const today = asLocalDay('2026-06-15');

  it('steps backwards a day at a time', () => {
    const onChange = jest.fn();
    renderThemed(<DayNavigator day={today} today={today} onChange={onChange} />);

    fireEvent.press(screen.getByLabelText('Previous day'));

    expect(onChange).toHaveBeenCalledWith('2026-06-14');
  });

  /** A diary records what happened; tomorrow has nothing to record. */
  it('does not offer a day beyond today', () => {
    const onChange = jest.fn();
    renderThemed(<DayNavigator day={today} today={today} onChange={onChange} />);

    fireEvent.press(screen.getByLabelText('Next day'));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does offer forward when looking at the past', () => {
    const onChange = jest.fn();
    renderThemed(
      <DayNavigator day={asLocalDay('2026-06-10')} today={today} onChange={onChange} />,
    );

    fireEvent.press(screen.getByLabelText('Next day'));

    expect(onChange).toHaveBeenCalledWith('2026-06-11');
  });
});

describe('DayTotalsBar', () => {
  it('shows a dash rather than a zero for a nutrient nobody reported', () => {
    renderThemed(
      <DayTotalsBar
        totals={{
          calories: 261,
          protein_g: 3.9,
          carbohydrates_g: 40,
          fat_g: 2.6,
          fiber_g: null,
          sugar_g: null,
          saturated_fat_g: null,
          sodium_mg: null,
        }}
      />,
    );

    expect(screen.getByText('261')).toBeTruthy();
    expect(screen.getByText('3.9 g')).toBeTruthy();
  });
});

describe('SyncNotice', () => {
  const base = { phase: 'idle' as const, lastSyncedAt: null };

  it('says nothing when there is nothing to say', () => {
    const { toJSON } = renderThemed(
      <SyncNotice status={{ ...base, pendingCount: 0, lastError: null }} />,
    );
    expect(toJSON()).toBeNull();
  });

  it('accounts for entries that have not been sent', () => {
    renderThemed(<SyncNotice status={{ ...base, pendingCount: 1, lastError: null }} />);
    expect(screen.getByText('1 change waiting to sync.')).toBeTruthy();
  });

  /**
   * The wording matters: nothing is lost and nothing is the user's to fix, so
   * this reports where their data is rather than raising an alarm.
   */
  it('reassures rather than alarms when a sync failed', () => {
    renderThemed(
      <SyncNotice
        status={{ ...base, pendingCount: 3, lastError: 'Network request failed' }}
      />,
    );
    expect(screen.getByText('3 changes saved on this device — not synced yet.')).toBeTruthy();
  });
});

describe('defaultMealFor', () => {
  const at = (utcHour: string) => new Date(`2026-06-15T${utcHour}:00:00.000Z`);

  it('follows the clock in the user zone, not the device zone', () => {
    // 08:00 UTC is 10:00 in Zurich (breakfast) and 22:00 in Honolulu (snack).
    expect(defaultMealFor(at('08'), 'Europe/Zurich')).toBe('breakfast');
    expect(defaultMealFor(at('08'), 'Pacific/Honolulu')).toBe('snack');
  });

  it('covers the rest of the day', () => {
    expect(defaultMealFor(at('11'), 'Europe/Zurich')).toBe('lunch');
    expect(defaultMealFor(at('17'), 'Europe/Zurich')).toBe('dinner');
    expect(defaultMealFor(at('21'), 'Europe/Zurich')).toBe('snack');
  });
});
