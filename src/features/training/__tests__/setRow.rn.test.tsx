import { fireEvent, render, screen } from '@testing-library/react-native';

import type { WorkoutSet } from '@/db/repositories/workouts';
import { ThemeProvider } from '@/theme';
import { SetRow } from '../SetRow';

function renderThemed(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

/**
 * The set row, as a thumb and a screen reader meet it.
 *
 * This is the control the feature is judged on. Two things are being pinned
 * down: that a weight typed in pounds is stored as kilograms, and that every
 * action announces which set it acts on — "done" alone is useless when there
 * are four of them on screen.
 */

const set = (overrides: Partial<WorkoutSet> = {}): WorkoutSet => ({
  id: 'set-1',
  setNumber: 2,
  weightKg: 70,
  weightUnit: 'kg',
  reps: 8,
  durationSeconds: null,
  distanceM: null,
  isCompleted: false,
  notes: null,
  ...overrides,
});

const noop = () => undefined;

describe('SetRow', () => {
  it('shows a weight and a rep field for weighted work', () => {
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByLabelText('Set 2 weight in kilograms')).toBeTruthy();
    expect(screen.getByLabelText('Set 2 reps')).toBeTruthy();
  });

  it('shows seconds for a held set, and no weight at all', () => {
    renderThemed(
      <SetRow
        set={set({ weightKg: null, reps: null, durationSeconds: 45 })}
        loadType="duration"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByLabelText('Set 2 duration in seconds')).toBeTruthy();
    expect(screen.queryByLabelText('Set 2 weight in kilograms')).toBeNull();
  });

  it('shows metres for a distance set', () => {
    renderThemed(
      <SetRow
        set={set({ weightKg: null, reps: null, distanceM: 5000 })}
        loadType="distance"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByLabelText('Set 2 distance in metres')).toBeTruthy();
  });

  it('commits on blur, not on every keystroke', () => {
    const onChange = jest.fn();
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={onChange}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    const field = screen.getByLabelText('Set 2 reps');

    // Typing "10" passes through "1", which is not a rep count anybody entered.
    fireEvent.changeText(field, '1');
    fireEvent.changeText(field, '10');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent(field, 'blur');
    expect(onChange).toHaveBeenCalledWith({ reps: 10 });
  });

  it('converts a weight typed in pounds to canonical kilograms', () => {
    const onChange = jest.fn();
    renderThemed(
      <SetRow
        set={set({ weightKg: null })}
        loadType="weighted"
        unit="lb"
        onChange={onChange}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    const field = screen.getByLabelText('Set 2 weight in pounds');
    fireEvent.changeText(field, '155');
    fireEvent(field, 'blur');

    // Never "155 lb" as a string, and never 155 as a kilogram value.
    expect(onChange).toHaveBeenCalledWith({ weightKg: 70.307 });
  });

  it('shows a stored weight back in the unit the user reads', () => {
    renderThemed(
      <SetRow
        set={set({ weightKg: 70.307 })}
        loadType="weighted"
        unit="lb"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByLabelText('Set 2 weight in pounds').props.value).toBe('155');
  });

  it('treats an emptied field as null, not as zero', () => {
    const onChange = jest.fn();
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={onChange}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    const field = screen.getByLabelText('Set 2 weight in kilograms');
    fireEvent.changeText(field, '');
    fireEvent(field, 'blur');

    expect(onChange).toHaveBeenCalledWith({ weightKg: null });
  });

  it('announces the whole set on the tick, not just "done"', () => {
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    // Four sets on screen all announcing "done" would be unusable.
    expect(screen.getByLabelText('Set 2: 70 kilograms, 8 reps')).toBeTruthy();
  });

  it('exposes completion as a checkbox state, not only as a colour', () => {
    const { rerender } = renderThemed(
      <SetRow
        set={set({ isCompleted: false })}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(
      screen.getByLabelText('Set 2: 70 kilograms, 8 reps').props.accessibilityState,
    ).toMatchObject({ checked: false });

    rerender(
      <ThemeProvider>
        <SetRow
          set={set({ isCompleted: true })}
          loadType="weighted"
          unit="kg"
          onChange={noop}
          onToggle={noop}
          onDelete={noop}
        />
      </ThemeProvider>,
    );

    expect(
      screen.getByLabelText('Set 2: 70 kilograms, 8 reps, done').props.accessibilityState,
    ).toMatchObject({ checked: true });
  });

  it('toggles on tap', () => {
    const onToggle = jest.fn();
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={onToggle}
        onDelete={noop}
      />,
    );

    fireEvent.press(screen.getByLabelText('Set 2: 70 kilograms, 8 reps'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('names the set on the delete button too', () => {
    const onDelete = jest.fn();
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={onDelete}
      />,
    );

    fireEvent.press(screen.getByLabelText('Delete set 2'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('shows what was done last time in this slot', () => {
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        previousLabel="65 kilograms, 10 reps, done"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByText(/Last time: 65 kilograms, 10 reps/)).toBeTruthy();
  });

  it('says what is wrong in words and keeps what was typed', () => {
    renderThemed(
      <SetRow
        set={set({ reps: null })}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    // Not a red border alone, and the weight field is untouched.
    expect(screen.getByText('How many reps?')).toBeTruthy();
    expect(screen.getByLabelText('Set 2 weight in kilograms').props.value).toBe('70');
  });

  it('offers zero rather than a dash as the bodyweight placeholder', () => {
    renderThemed(
      <SetRow
        set={set({ weightKg: null, reps: 20 })}
        loadType="bodyweight"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByLabelText('Set 2 weight in kilograms').props.placeholder).toBe('0');
  });

  it('reads a bodyweight set as bodyweight, not as zero kilograms', () => {
    renderThemed(
      <SetRow
        set={set({ weightKg: 0, reps: 20 })}
        loadType="bodyweight"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByLabelText('Set 2: bodyweight, 20 reps')).toBeTruthy();
  });

  it('gives the tick a target larger than the accessibility minimum', () => {
    renderThemed(
      <SetRow
        set={set()}
        loadType="weighted"
        unit="kg"
        onChange={noop}
        onToggle={noop}
        onDelete={noop}
      />,
    );

    const tick = screen.getByLabelText('Set 2: 70 kilograms, 8 reps');
    const style = tick.props.style as { minHeight?: number };

    // It is used mid-set, one-handed, sometimes without looking.
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });
});
