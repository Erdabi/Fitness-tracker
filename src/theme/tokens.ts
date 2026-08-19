/**
 * Design tokens.
 *
 * Every colour, space, radius and type style in the app resolves through this
 * file. Components never hardcode a hex value or a magic number — that is what
 * keeps light and dark consistent and makes a palette change a one-file edit.
 *
 * Semantic colour (success / warning / danger) is deliberately separate from
 * the brand accent, and `provenance` is its own scale because "where did this
 * number come from" is a first-class concept in this product: a verified
 * catalogue entry, an AI estimate and a user-entered value must never look
 * alike.
 */

/* --------------------------------------------------------------- palette -- */

const palette = {
  // Brand: a deep ultramarine. Reads precise rather than sporty-generic.
  indigo50: '#EEF1FC',
  indigo100: '#D9E0F8',
  indigo300: '#8B9CF5',
  indigo500: '#3A4FC4',
  indigo600: '#2438A8',
  indigo700: '#1B2A82',

  // Cool neutrals, biased slightly toward the accent so greys read as chosen.
  grey0: '#FFFFFF',
  grey50: '#F5F6F8',
  grey100: '#EEF0F4',
  grey200: '#DDE1E9',
  grey300: '#C9CED8',
  grey400: '#949CAC',
  grey500: '#5C6474',
  grey600: '#39404E',
  grey800: '#1F242E',
  grey850: '#161A21',
  grey900: '#12151C',
  grey950: '#0E1116',

  teal500: '#0E6353',
  teal400: '#55C4A9',
  teal50: '#DDEFEA',
  teal900: '#0F2B26',

  amber600: '#8F5D00',
  amber400: '#E3AA52',
  amber50: '#FBF0DC',
  amber900: '#33270F',

  red600: '#A8261E',
  red400: '#F09187',
  red50: '#FAE4E2',
  red900: '#331714',
} as const;

/* ---------------------------------------------------------------- scheme -- */

export interface ColorScheme {
  /** Page background. */
  background: string;
  /** Raised surface: cards, sheets, inputs. */
  surface: string;
  /** Secondary surface: pressed states, subtle fills. */
  surfaceMuted: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  /** Text placed on top of `accent`. */
  textOnAccent: string;

  border: string;
  borderStrong: string;

  accent: string;
  accentMuted: string;
  accentPressed: string;

  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;

  /** Where a displayed number came from. */
  provenanceVerified: string;
  provenanceEstimated: string;
  provenanceManual: string;

  /** Overlay behind modals and sheets. */
  scrim: string;
}

const lightColors: ColorScheme = {
  background: palette.grey50,
  surface: palette.grey0,
  surfaceMuted: palette.grey100,

  textPrimary: palette.grey900,
  textSecondary: palette.grey600,
  textMuted: palette.grey500,
  textOnAccent: palette.grey0,

  border: palette.grey300,
  borderStrong: palette.grey400,

  accent: palette.indigo600,
  accentMuted: palette.indigo50,
  accentPressed: palette.indigo700,

  success: palette.teal500,
  successMuted: palette.teal50,
  warning: palette.amber600,
  warningMuted: palette.amber50,
  danger: palette.red600,
  dangerMuted: palette.red50,

  provenanceVerified: palette.teal500,
  provenanceEstimated: palette.amber600,
  provenanceManual: palette.grey500,

  scrim: 'rgba(18, 21, 28, 0.45)',
};

const darkColors: ColorScheme = {
  background: palette.grey950,
  surface: palette.grey850,
  surfaceMuted: palette.grey800,

  textPrimary: '#E9EBEF',
  textSecondary: '#C2C8D2',
  textMuted: palette.grey400,
  textOnAccent: palette.grey950,

  border: '#333A47',
  borderStrong: palette.grey500,

  accent: palette.indigo300,
  accentMuted: '#1C2340',
  accentPressed: '#A6B3F8',

  success: palette.teal400,
  successMuted: palette.teal900,
  warning: palette.amber400,
  warningMuted: palette.amber900,
  danger: palette.red400,
  dangerMuted: palette.red900,

  provenanceVerified: palette.teal400,
  provenanceEstimated: palette.amber400,
  provenanceManual: palette.grey400,

  scrim: 'rgba(0, 0, 0, 0.6)',
};

/* ----------------------------------------------------------------- scale -- */

/** 4pt base grid. Named by step, not by pixel value, so the scale can shift. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/**
 * Minimum interactive size. Apple's HIG says 44pt; Material says 48dp. Taking
 * the larger keeps both platforms compliant and suits a one-handed app used
 * mid-workout.
 */
export const MIN_TOUCH_TARGET = 48;

export const typography = {
  displayLarge: { fontSize: 34, lineHeight: 40, fontWeight: '700' },
  displayMedium: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  /** Uppercase micro-labels; pair with letterSpacing. */
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.8 },
  /** Large figures on the dashboard; tabular so digits do not jitter. */
  metric: { fontSize: 32, lineHeight: 36, fontWeight: '700' },
} as const;

export type TypographyVariant = keyof typeof typography;

export const duration = {
  instant: 100,
  fast: 160,
  normal: 240,
} as const;

/* ----------------------------------------------------------------- theme -- */

export interface Theme {
  readonly name: 'light' | 'dark';
  readonly colors: ColorScheme;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  readonly duration: typeof duration;
}

export const lightTheme: Theme = {
  name: 'light',
  colors: lightColors,
  spacing,
  radius,
  typography,
  duration,
};

export const darkTheme: Theme = {
  name: 'dark',
  colors: darkColors,
  spacing,
  radius,
  typography,
  duration,
};
