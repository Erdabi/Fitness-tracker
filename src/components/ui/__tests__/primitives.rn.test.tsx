import { fireEvent, render, screen } from '@testing-library/react-native';

import { ThemeProvider } from '@/theme';
import { Button } from '../Button';
import { TextField } from '../TextField';
import { EmptyState, ErrorState } from '../states';

function renderThemed(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('Button', () => {
  it('fires onPress when enabled', () => {
    const onPress = jest.fn();
    renderThemed(<Button label="Sign in" onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this catches: a double-tap on a submit button firing two sign-up
   * requests, which the API rejects as a duplicate account.
   */
  it('ignores presses while loading', () => {
    const onPress = jest.fn();
    renderThemed(<Button label="Sign in" loading onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('ignores presses while disabled', () => {
    const onPress = jest.fn();
    renderThemed(<Button label="Sign in" disabled onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('announces its busy and disabled state to assistive tech', () => {
    renderThemed(<Button label="Saving" loading onPress={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toBeDisabled();
    expect(button).toBeBusy();
  });

  it('keeps the label mounted while loading so the width does not jump', () => {
    renderThemed(<Button label="Sign in" loading onPress={jest.fn()} />);

    expect(screen.getByText('Sign in')).toBeOnTheScreen();
  });
});

describe('TextField', () => {
  it('links the label to the input for screen readers', () => {
    renderThemed(<TextField label="Email" value="" onChangeText={jest.fn()} />);

    expect(screen.getByLabelText('Email')).toBeOnTheScreen();
  });

  it('shows an error message when given one', () => {
    renderThemed(
      <TextField
        label="Email"
        value="nope"
        onChangeText={jest.fn()}
        error="That does not look like an email address"
      />,
    );

    expect(
      screen.getByText('That does not look like an email address'),
    ).toBeOnTheScreen();
  });

  it('shows the hint only while there is no error', () => {
    const { rerender } = renderThemed(
      <TextField
        label="Password"
        value=""
        onChangeText={jest.fn()}
        hint="At least 8 characters"
      />,
    );
    expect(screen.getByText('At least 8 characters')).toBeOnTheScreen();

    rerender(
      <ThemeProvider>
        <TextField
          label="Password"
          value=""
          onChangeText={jest.fn()}
          hint="At least 8 characters"
          error="Use at least 8 characters"
        />
      </ThemeProvider>,
    );

    expect(screen.queryByText('At least 8 characters')).not.toBeOnTheScreen();
    expect(screen.getByText('Use at least 8 characters')).toBeOnTheScreen();
  });

  it('toggles password visibility', () => {
    renderThemed(
      <TextField label="Password" value="secret" onChangeText={jest.fn()} secureToggle />,
    );

    expect(screen.getByLabelText('Show password')).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Show password'));

    expect(screen.getByLabelText('Hide password')).toBeOnTheScreen();
  });

  it('reports changes to the caller', () => {
    const onChangeText = jest.fn();
    renderThemed(<TextField label="Email" value="" onChangeText={onChangeText} />);

    fireEvent.changeText(screen.getByLabelText('Email'), 'sam@example.com');

    expect(onChangeText).toHaveBeenCalledWith('sam@example.com');
  });
});

describe('state components', () => {
  it('renders an empty state with its call to action', () => {
    const onAction = jest.fn();
    renderThemed(
      <EmptyState
        title="Nothing logged yet"
        description="Add your first meal to get started."
        actionLabel="Add food"
        onAction={onAction}
      />,
    );

    expect(screen.getByText('Nothing logged yet')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Add food' }));
    expect(onAction).toHaveBeenCalled();
  });

  it('offers a retry on the error state', () => {
    const onRetry = jest.fn();
    renderThemed(<ErrorState description="No connection." onRetry={onRetry} />);

    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalled();
  });

  it('omits the retry button when no handler is given', () => {
    renderThemed(<ErrorState description="No connection." />);

    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
});
