import { fireEvent, render, screen } from '@testing-library/react-native';

import type { WorkoutExerciseDetail, WorkoutSet } from '@/db/repositories/workouts';
import { summariseExercise } from '@/lib/training';
import { ThemeProvider } from '@/theme';
import {
  ExerciseSection,
  type ExerciseSectionActions,
} from '../ExerciseSection';

function renderThemed(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

/**
 * One exercise inside a session.
 *
 * The two behaviours worth pinning down are the ones that are easy to get
 * quietly wrong: that reordering works without a drag gesture — section O
 * requires a non-gesture alternative, and a drag is unusable with a screen
 * reader or one hand mid-set — and that "add set" offers the previous set's
 * numbers without claiming they were performed.
 */

const set = (overrides: Partial<WorkoutSet> = {}): WorkoutSet => ({
  id: 'set-1',
  setNumber: 1,
  weightKg: 70,
  weightUnit: 'kg',
  reps: 8,
  durationSeconds: null,
  distanceM: null,
  isCompleted: true,
  notes: null,
  ...overrides,
});

function exercise(
  overrides: Partial<WorkoutExerciseDetail> = {},
): WorkoutExerciseDetail {
  const sets = overrides.sets ?? [set()];
  const loadType = overrides.loadType ?? 'weighted';

  return {
    id: 'we-1',
    exerciseId: 'ex-1',
    name: 'Barbell Bench Press',
    loadType,
    position: 0,
    notes: null,
    targetSets: null,
    targetReps: null,
    sets,
    summary: summariseExercise(sets, loadType),
    ...overrides,
  };
}

function actions(): ExerciseSectionActions & {
  [K in keyof ExerciseSectionActions]: jest.Mock;
} {
  return {
    reorderExercises: jest.fn(),
    removeExercise: jest.fn(),
    addSet: jest.fn(),
    editSet: jest.fn(),
    toggleSet: jest.fn(),
    removeSet: jest.fn(),
  } as never;
}

function renderSection(
  props: Partial<React.ComponentProps<typeof ExerciseSection>> = {},
) {
  const mutations = props.mutations ?? actions();

  renderThemed(
    <ExerciseSection
      exercise={props.exercise ?? exercise()}
      index={props.index ?? 0}
      total={props.total ?? 2}
      workoutId="w-1"
      unit={props.unit ?? 'kg'}
      mutations={mutations}
      allIds={props.allIds ?? ['we-1', 'we-2']}
      previous={props.previous ?? null}
    />,
  );

  return mutations as ReturnType<typeof actions>;
}

describe('ExerciseSection', () => {
  it('names the exercise on both reorder buttons', () => {
    renderSection();

    // "Move up" alone is ambiguous with six exercises on screen.
    expect(screen.getByLabelText('Move Barbell Bench Press up')).toBeTruthy();
    expect(screen.getByLabelText('Move Barbell Bench Press down')).toBeTruthy();
  });

  it('reorders without any gesture at all', () => {
    const mutations = renderSection({ index: 1, allIds: ['we-0', 'we-1'] });

    fireEvent.press(screen.getByLabelText('Move Barbell Bench Press up'));

    expect(mutations.reorderExercises).toHaveBeenCalledWith('w-1', ['we-1', 'we-0']);
  });

  it('disables the move that would go off the end, and says so', () => {
    renderSection({ index: 0, total: 2 });

    const up = screen.getByLabelText('Move Barbell Bench Press up');
    expect(up.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('offers the previous set numbers when adding a set', () => {
    const mutations = renderSection({
      exercise: exercise({ sets: [set({ weightKg: 70, reps: 8 })] }),
    });

    fireEvent.press(screen.getByLabelText('Add set'));

    expect(mutations.addSet).toHaveBeenCalledWith(
      expect.objectContaining({ weightKg: 70, reps: 8 }),
    );
  });

  it('never marks an offered set as performed', () => {
    const mutations = renderSection();

    fireEvent.press(screen.getByLabelText('Add set'));

    // Copying the tick as well would forge a set nobody did.
    expect(mutations.addSet).toHaveBeenCalledWith(
      expect.objectContaining({ isCompleted: false }),
    );
  });

  it('falls back to last session when this exercise has no sets yet', () => {
    const mutations = renderSection({
      exercise: exercise({ sets: [] }),
      previous: { sets: [set({ weightKg: 65, reps: 10 })] },
    });

    fireEvent.press(screen.getByLabelText('Add set'));

    expect(mutations.addSet).toHaveBeenCalledWith(
      expect.objectContaining({ weightKg: 65, reps: 10 }),
    );
  });

  it('starts a bodyweight set at zero rather than at nothing', () => {
    const mutations = renderSection({
      exercise: exercise({ sets: [], loadType: 'bodyweight' }),
    });

    fireEvent.press(screen.getByLabelText('Add set'));

    // Zero is "no added weight", which is what a push-up is.
    expect(mutations.addSet).toHaveBeenCalledWith(
      expect.objectContaining({ weightKg: 0 }),
    );
  });

  it('shows last session and announces it in full', () => {
    renderSection({
      previous: { sets: [set({ weightKg: 65, reps: 10 }), set({ weightKg: 65, reps: 9 })] },
    });

    expect(screen.getByText(/Previous: 65 × 10, 65 × 9/)).toBeTruthy();
    // The multiplication sign is skipped or read as "x" by screen readers.
    expect(
      screen.getByLabelText(/Previous Barbell Bench Press: 65 kilograms, 10 reps/),
    ).toBeTruthy();
  });

  it('shows an estimated 1RM for weighted work, marked as an estimate', () => {
    renderSection({
      exercise: exercise({ sets: [set({ weightKg: 100, reps: 5 })] }),
    });

    expect(screen.getByText(/Estimated 1RM 116.7 kg/)).toBeTruthy();
    expect(screen.getByText(/not a measured maximum/)).toBeTruthy();
  });

  it('shows no 1RM at all for bodyweight work', () => {
    renderSection({
      exercise: exercise({
        loadType: 'bodyweight',
        sets: [set({ weightKg: 0, reps: 20 })],
      }),
    });

    // A misleading zero would be worse than nothing.
    expect(screen.queryByText(/Estimated 1RM/)).toBeNull();
  });

  it('shows no 1RM for a held set', () => {
    renderSection({
      exercise: exercise({
        loadType: 'duration',
        sets: [set({ weightKg: null, reps: null, durationSeconds: 45 })],
      }),
    });

    expect(screen.queryByText(/Estimated 1RM/)).toBeNull();
  });

  it('removes the exercise on request', () => {
    const mutations = renderSection();

    fireEvent.press(screen.getByLabelText('Remove'));

    expect(mutations.removeExercise).toHaveBeenCalledWith('we-1');
  });

  it('renders one row per set, each individually addressable', () => {
    renderSection({
      exercise: exercise({
        sets: [set({ id: 'a', setNumber: 1 }), set({ id: 'b', setNumber: 2 })],
      }),
    });

    expect(screen.getByLabelText('Delete set 1')).toBeTruthy();
    expect(screen.getByLabelText('Delete set 2')).toBeTruthy();
  });
});
