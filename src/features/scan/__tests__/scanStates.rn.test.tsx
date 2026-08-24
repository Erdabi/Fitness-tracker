import { fireEvent, render, screen } from '@testing-library/react-native';

import { appError } from '@/lib/result';
import { ThemeProvider } from '@/theme';
import { NutrientFieldset } from '../NutrientFieldset';
import { EMPTY_NUTRIENT_DRAFT } from '../nutrientFields';
import {
  AnalyzingState,
  BlockingProblems,
  ConfidenceNotice,
  ScanErrorState,
  ScanWarnings,
} from '../ScanStates';

function renderThemed(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

/**
 * The states a scan passes through, as a screen reader meets them.
 *
 * These are the screens where an accessibility failure is a data failure: the
 * whole point of a review step is that the user reads what the model produced,
 * so a result that is only conveyed by colour, or a spinner that announces
 * nothing, defeats the feature rather than merely inconveniencing someone.
 */

describe('AnalyzingState', () => {
  it('announces itself, since nothing moves focus when analysis starts', () => {
    renderThemed(<AnalyzingState label="Reading the nutrition panel" />);

    const region = screen.getByLabelText(/Reading the nutrition panel/);
    expect(region.props.accessibilityLiveRegion).toBe('polite');
  });

  it('says roughly how long it will take', () => {
    renderThemed(<AnalyzingState label="Looking at your meal" />);
    expect(screen.getByText(/few seconds/i)).toBeTruthy();
  });
});

describe('ScanErrorState', () => {
  it('separates being offline from everything else', () => {
    renderThemed(
      <ScanErrorState
        error={appError('network', 'Reading a label needs a connection.', {
          code: 'ai_offline',
          retryable: true,
        })}
      />,
    );

    expect(screen.getByText('No connection')).toBeTruthy();
  });

  it('states the failure in words, not only in colour', () => {
    renderThemed(
      <ScanErrorState
        error={appError('server', 'Scanning failed.', { code: 'x', retryable: true })}
      />,
    );

    expect(screen.getByText('That did not work')).toBeTruthy();
  });

  it('offers alternatives that work without a connection', () => {
    const onSearch = jest.fn();
    const onManual = jest.fn();

    renderThemed(
      <ScanErrorState
        error={appError('network', 'No connection.', { code: 'ai_offline', retryable: true })}
        onSearch={onSearch}
        onManual={onManual}
      />,
    );

    fireEvent.press(screen.getByLabelText('Search for the food'));
    fireEvent.press(screen.getByLabelText('Enter it by hand'));

    expect(onSearch).toHaveBeenCalled();
    expect(onManual).toHaveBeenCalled();
  });

  it('does not offer a retry for something retrying cannot fix', () => {
    renderThemed(
      <ScanErrorState
        error={appError('validation', 'That image is too large.', {
          code: 'image_too_large',
          retryable: false,
        })}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.queryByLabelText('Try again')).toBeNull();
  });
});

describe('ConfidenceNotice', () => {
  it('turns low confidence into an instruction, not a colour', () => {
    renderThemed(<ConfidenceNotice confidence="low" kind="label" />);

    expect(screen.getByText(/check every value/i)).toBeTruthy();
  });

  it('says a photo portion is an estimate even at high confidence', () => {
    renderThemed(<ConfidenceNotice confidence="high" kind="photo" />);

    expect(screen.getByText(/always estimates/i)).toBeTruthy();
  });

  it('words a label and a photo differently at the same confidence', () => {
    const label = renderThemed(<ConfidenceNotice confidence="medium" kind="label" />);
    const labelText = screen.getByText(/against the packet/i);
    expect(labelText).toBeTruthy();
    label.unmount();

    renderThemed(<ConfidenceNotice confidence="medium" kind="photo" />);
    expect(screen.getByText(/angle/i)).toBeTruthy();
  });

  it('announces the whole notice as one label', () => {
    renderThemed(<ConfidenceNotice confidence="low" kind="photo" />);

    // Fragmented Text nodes read as separate items and lose the connection
    // between the heading and what to do about it.
    expect(screen.getByLabelText(/rough guess/i)).toBeTruthy();
  });
});

describe('ScanWarnings', () => {
  it('shows nothing when there is nothing to say', () => {
    renderThemed(<ScanWarnings warnings={[]} />);
    expect(screen.queryByText('Worth knowing')).toBeNull();
  });

  it('lists what the model flagged', () => {
    renderThemed(<ScanWarnings warnings={['Glare across the fat row.']} />);
    expect(screen.getByText(/Glare across the fat row/)).toBeTruthy();
  });
});

describe('BlockingProblems', () => {
  it('shows nothing when the values hold together', () => {
    renderThemed(<BlockingProblems problems={[]} />);
    expect(screen.queryByText('Fix before saving')).toBeNull();
  });

  it('says what is wrong, per field', () => {
    renderThemed(
      <BlockingProblems
        problems={[{ field: 'calories', message: 'Energy of 3790 exceeds 1000 per 100.' }]}
      />,
    );

    expect(screen.getByText(/exceeds 1000 per 100/)).toBeTruthy();
  });
});

describe('NutrientFieldset', () => {
  it('offers every nutrient the catalogue stores', () => {
    renderThemed(
      <NutrientFieldset
        draft={EMPTY_NUTRIENT_DRAFT}
        errors={{}}
        basisLabel="Per 100 g"
        onChange={jest.fn()}
      />,
    );

    for (const label of [
      'Energy (kcal)',
      'Protein (g)',
      'Carbohydrate (g)',
      'of which sugars (g)',
      'Fibre (g)',
      'Fat (g)',
      'of which saturates (g)',
      'Sodium (mg)',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('states what the numbers are per, so a portion is not typed as a per-100 figure', () => {
    renderThemed(
      <NutrientFieldset
        draft={EMPTY_NUTRIENT_DRAFT}
        errors={{}}
        basisLabel="For this portion"
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText('For this portion')).toBeTruthy();
  });

  it('marks a field the scan could not read', () => {
    renderThemed(
      <NutrientFieldset
        draft={EMPTY_NUTRIENT_DRAFT}
        errors={{}}
        basisLabel="Per 100 g"
        missing={['fiber_g']}
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText(/Could not be read/)).toBeTruthy();
  });

  it('reports an invalid entry under the field it belongs to', () => {
    renderThemed(
      <NutrientFieldset
        draft={{ ...EMPTY_NUTRIENT_DRAFT, fat_g: 'about six' }}
        errors={{ fat_g: 'Enter a number, or leave it empty.' }}
        basisLabel="Per 100 g"
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText('Enter a number, or leave it empty.')).toBeTruthy();
  });

  it('reports each edit with the field it came from', () => {
    const onChange = jest.fn();

    renderThemed(
      <NutrientFieldset
        draft={EMPTY_NUTRIENT_DRAFT}
        errors={{}}
        basisLabel="Per 100 g"
        onChange={onChange}
      />,
    );

    fireEvent.changeText(screen.getByLabelText('Protein (g)'), '13.2');
    expect(onChange).toHaveBeenCalledWith('protein_g', '13.2');
  });
});
