import { fireEvent, render, screen } from '@testing-library/react-native';

import { ThemeProvider } from '@/theme';
import type { WaterDay } from '@/db/repositories/water';
import type { DayTotals } from '@/db/repositories/foodLogs';
import type { NutritionGoalRow, WeightEntryRow } from '@/db/schema';
import { goalProgress } from '@/lib/energy';
import { asLocalDay } from '@/lib/date';
import { CalorieCard } from '../CalorieCard';
import { DashboardSection } from '../DashboardSection';
import { WaterCard } from '../WaterCard';
import { WeightCard } from '../WeightCard';

function renderThemed(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const EMPTY_TOTALS = {
  calories: 0,
  protein_g: 0,
  carbohydrates_g: 0,
  fat_g: 0,
  fiber_g: null,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
};

const TOTALS: DayTotals = {
  day: asLocalDay('2026-06-15'),
  entryCount: 3,
  total: {
    calories: 1620,
    protein_g: 120,
    carbohydrates_g: 180,
    fat_g: 55,
    fiber_g: 12,
    sugar_g: null,
    saturated_fat_g: null,
    sodium_mg: null,
  },
  byMeal: {
    breakfast: { entryCount: 1, total: EMPTY_TOTALS },
    lunch: { entryCount: 1, total: EMPTY_TOTALS },
    dinner: { entryCount: 1, total: EMPTY_TOTALS },
    snack: { entryCount: 0, total: EMPTY_TOTALS },
  },
};

const GOAL = {
  id: 'goal-1',
  calorie_target: 2100,
  protein_target_g: 150,
  carbohydrate_target_g: 220,
  fat_target_g: 70,
} as unknown as NutritionGoalRow;

const WATER: WaterDay = {
  day: asLocalDay('2026-06-15'),
  consumedMl: 1750,
  entryCount: 3,
  targetMl: 2500,
  progress: goalProgress(1750, 2500),
};

describe('CalorieCard', () => {
  it('shows consumed against the goal, with what is left', () => {
    renderThemed(<CalorieCard totals={TOTALS} goal={GOAL} progress={goalProgress(1620, 2100)} />);

    expect(
      screen.getByLabelText('1,620 of 2,100 calories, 480 remaining.'),
    ).toBeTruthy();
    expect(screen.getByText('remaining')).toBeTruthy();
    expect(screen.getByText('480')).toBeTruthy();
  });

  it('shows the progress percentage', () => {
    renderThemed(<CalorieCard totals={TOTALS} goal={GOAL} progress={goalProgress(1620, 2100)} />);
    expect(screen.getByText('77%')).toBeTruthy();
  });

  /**
   * The overage must never read as an allowance. "−150 remaining" tells a user
   * they have 150 kcal left when in fact they are 150 past.
   */
  it('shows an overage as an overage rather than a negative remainder', () => {
    const over = { ...TOTALS, total: { ...TOTALS.total, calories: 2250 } };
    renderThemed(<CalorieCard totals={over} goal={GOAL} progress={goalProgress(2250, 2100)} />);

    expect(screen.getByText('over')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
    expect(screen.queryByText('-150')).toBeNull();
    expect(screen.queryByText('−150')).toBeNull();
    expect(
      screen.getByLabelText('2,250 of 2,100 calories, 150 over.'),
    ).toBeTruthy();
  });

  /**
   * The bar is clamped so it cannot overflow its track, and `fraction` with
   * it. The percentage must therefore come from the raw figures — otherwise
   * somebody at 107% is told 100%, which is the one number this card exists
   * to get right.
   */
  it('reports a percentage past 100 rather than clamping it', () => {
    const over = { ...TOTALS, total: { ...TOTALS.total, calories: 2250 } };
    renderThemed(<CalorieCard totals={over} goal={GOAL} progress={goalProgress(2250, 2100)} />);

    expect(screen.getByText('107%')).toBeTruthy();
    expect(goalProgress(2250, 2100).fraction).toBe(1);
  });

  it('says so when nothing has been logged', () => {
    const empty: DayTotals = { ...TOTALS, entryCount: 0, total: EMPTY_TOTALS };
    renderThemed(<CalorieCard totals={empty} goal={GOAL} progress={goalProgress(0, 2100)} />);

    expect(screen.getByText('No food logged yet today.')).toBeTruthy();
  });

  it('offers a way to set a goal when there is none', () => {
    const onPress = jest.fn();
    renderThemed(
      <CalorieCard totals={TOTALS} goal={null} progress={null} onPress={onPress} />,
    );

    fireEvent.press(screen.getByText('Set a calorie goal to track against →'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('describes each macro for a screen reader', () => {
    renderThemed(<CalorieCard totals={TOTALS} goal={GOAL} progress={goalProgress(1620, 2100)} />);
    expect(screen.getByLabelText('Protein, 120 of 150 grams')).toBeTruthy();
    expect(screen.getByLabelText('Carbs, 180 of 220 grams')).toBeTruthy();
    expect(screen.getByLabelText('Fat, 55 of 70 grams')).toBeTruthy();
  });
});

describe('WaterCard', () => {
  it('shows consumed against the goal in one unit', () => {
    renderThemed(<WaterCard water={WATER} system="metric" onAdd={jest.fn()} />);
    expect(screen.getByText('1.75 / 2.5 L')).toBeTruthy();
    expect(screen.getByText('750 ml remaining')).toBeTruthy();
  });

  it('switches units without touching what is stored', () => {
    renderThemed(<WaterCard water={WATER} system="imperial" onAdd={jest.fn()} />);
    expect(screen.getByText('59 / 85 fl oz')).toBeTruthy();
  });

  it('shows an overage as over goal, never as negative remaining', () => {
    const over: WaterDay = {
      ...WATER,
      consumedMl: 2800,
      progress: goalProgress(2800, 2500),
    };
    renderThemed(<WaterCard water={over} system="metric" onAdd={jest.fn()} />);

    expect(screen.getByText('+300 ml over goal')).toBeTruthy();
    expect(screen.queryByText('-300 ml remaining')).toBeNull();
  });

  /**
   * Every button calls the same handler with a different number. If they ever
   * diverge into their own logic, four buttons become four chances to get the
   * day or the unit wrong.
   */
  it.each([250, 500, 750, 1000])('logs %s ml through the one handler', (amount) => {
    const onAdd = jest.fn();
    renderThemed(<WaterCard water={WATER} system="metric" onAdd={onAdd} />);

    fireEvent.press(screen.getByLabelText(`Add ${amount >= 1000 ? '1 L' : `${amount} ml`} of water`));

    expect(onAdd).toHaveBeenCalledWith(amount);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('takes a custom amount through the same handler', () => {
    const onAdd = jest.fn();
    renderThemed(<WaterCard water={WATER} system="metric" onAdd={onAdd} />);

    fireEvent.press(screen.getByLabelText('Add a custom water amount'));
    fireEvent.changeText(screen.getByLabelText('Custom amount'), '330');
    fireEvent.press(screen.getByRole('button', { name: 'Add' }));

    expect(onAdd).toHaveBeenCalledWith(330);
  });

  it('refuses a custom amount outside the supported range', () => {
    const onAdd = jest.fn();
    renderThemed(<WaterCard water={WATER} system="metric" onAdd={onAdd} />);

    fireEvent.press(screen.getByLabelText('Add a custom water amount'));
    fireEvent.changeText(screen.getByLabelText('Custom amount'), '9000');
    fireEvent.press(screen.getByRole('button', { name: 'Add' }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it('says so when nothing has been logged', () => {
    const empty: WaterDay = { ...WATER, consumedMl: 0, entryCount: 0, progress: goalProgress(0, 2500) };
    renderThemed(<WaterCard water={empty} system="metric" onAdd={jest.fn()} />);
    expect(screen.getByText('No water logged yet today.')).toBeTruthy();
  });

  it('offers a way to set a goal when there is none', () => {
    const onSetGoal = jest.fn();
    const noGoal: WaterDay = { ...WATER, targetMl: null, progress: null };
    renderThemed(
      <WaterCard water={noGoal} system="metric" onAdd={jest.fn()} onSetGoal={onSetGoal} />,
    );

    fireEvent.press(screen.getByText('Set a daily water goal →'));
    expect(onSetGoal).toHaveBeenCalledTimes(1);
  });
});

describe('WeightCard', () => {
  const entry = (kg: number, id: string): WeightEntryRow =>
    ({
      id,
      user_id: 'u',
      measured_on: '2026-06-15',
      weight_kg: kg,
      note: null,
      created_at: 0,
      updated_at: 0,
      server_updated_at: null,
      deleted_at: null,
    }) as WeightEntryRow;

  it('shows the current weight and how it moved', () => {
    renderThemed(
      <WeightCard
        trend={{
          current: entry(78.4, 'a'),
          previous: entry(79.2, 'b'),
          changeKg: -0.8,
          overDays: 30,
        }}
        system="metric"
      />,
    );

    expect(screen.getByText('78.4 kg')).toBeTruthy();
    expect(screen.getByText('−0.8 kg')).toBeTruthy();
    expect(screen.getByText('over the last 30 days')).toBeTruthy();
  });

  it('describes the trend in words as well as in layout', () => {
    renderThemed(
      <WeightCard
        trend={{
          current: entry(78.4, 'a'),
          previous: entry(79.2, 'b'),
          changeKg: -0.8,
          overDays: 30,
        }}
        system="metric"
      />,
    );

    expect(
      screen.getByLabelText('Current weight 78.4 kg, down 0.8 kg over the last 30 days.'),
    ).toBeTruthy();
  });

  /** A single reading is a measurement, not a trend. */
  it('does not invent a change from one reading', () => {
    renderThemed(
      <WeightCard
        trend={{ current: entry(78.4, 'a'), previous: null, changeKg: null, overDays: 30 }}
        system="metric"
      />,
    );

    expect(screen.getByText('Add another reading to see how it is trending.')).toBeTruthy();
    expect(screen.queryByText('±0 kg')).toBeNull();
  });

  it('says so when there are no entries at all', () => {
    const onPress = jest.fn();
    renderThemed(
      <WeightCard
        trend={{ current: null, previous: null, changeKg: null, overDays: 30 }}
        system="metric"
        onPress={onPress}
      />,
    );

    expect(screen.getByText('No weight entries yet.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Record your weight'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows imperial when that is the preference', () => {
    renderThemed(
      <WeightCard
        trend={{ current: entry(78.4, 'a'), previous: null, changeKg: null, overDays: 30 }}
        system="imperial"
      />,
    );
    expect(screen.getByText('172.8 lb')).toBeTruthy();
  });
});

describe('DashboardSection', () => {
  /**
   * The whole reason each card is wrapped: React unmounts the entire tree on
   * an uncaught render error, so one broken card would blank the dashboard,
   * the header and the tab bar with it.
   */
  it('contains a crash to the one card that caused it', () => {
    const Broken = (): React.ReactElement => {
      throw new Error('render fault');
    };

    // React logs the caught error; silence it so the run stays readable.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderThemed(
      <>
        <DashboardSection name="Water">
          <Broken />
        </DashboardSection>
        <CalorieCard totals={TOTALS} goal={GOAL} progress={goalProgress(1620, 2100)} />
      </>,
    );

    expect(screen.getByText('Water could not be shown')).toBeTruthy();
    // The neighbouring card is untouched.
    expect(
      screen.getByLabelText('1,620 of 2,100 calories, 480 remaining.'),
    ).toBeTruthy();

    consoleError.mockRestore();
  });

  it('renders its child untouched when nothing is wrong', () => {
    renderThemed(
      <DashboardSection name="Water">
        <WaterCard water={WATER} system="metric" onAdd={jest.fn()} />
      </DashboardSection>,
    );

    expect(screen.getByText('1.75 / 2.5 L')).toBeTruthy();
    expect(screen.queryByText('Water could not be shown')).toBeNull();
  });
});
