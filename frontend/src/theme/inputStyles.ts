/**
 * inputStyles — the shared text-input "well" of the Ink & Cube system.
 *
 * A well is a field sunk into a card: `colors.surface` fill, a 1px
 * `colors.border` hairline, radius 14. Focus lifts it: `primaryLight` border
 * plus a 3px `colors.glow` ring. (`glow` is an rgba string composed into a
 * boxShadow string here — this is NOT hex-alpha concatenation.)
 *
 *   const input = useInputStyles();                              // themed screens
 *   <TextInput style={[input.well, styles.amount, focused && input.wellFocused]} … />
 *   <TextInput style={[input.well, input.wellCompact, styles.cell]} … />   // table cells / inline numerals
 *
 *   inputStyles.dark.well / inputStyles.light.well                // fixed-scheme screens (Login is always dark)
 *   createInputStyles(palette)                                    // any palette
 *
 * Callers add their own font/size/alignment on top; the well only owns the
 * box (fill, border, radius, padding) and the resting text colour.
 * `wellCompact` layers a tighter box (radius 10, 8/6 padding, 14px) over
 * `well` for grid cells — Pay's fee table and target Min/Good inputs.
 */
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { darkColors, lightColors, useColors, type ColorPalette } from './ThemeContext';

export function createInputStyles(colors: ColorPalette) {
  return StyleSheet.create({
    well: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 16,
      color: colors.text,
    },
    wellFocused: {
      borderColor: colors.primaryLight,
      boxShadow: '0 0 0 3px ' + colors.glow,
    },
    /** Tighter well for table cells / inline numerals (layer over `well`). */
    wellCompact: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 10,
      fontSize: 14,
    },
  });
}

export type InputStyles = ReturnType<typeof createInputStyles>;

/** Wells for the current theme (memoised per palette). */
export function useInputStyles(): InputStyles {
  const colors = useColors();
  return useMemo(() => createInputStyles(colors), [colors]);
}

/** Fixed-scheme sets for screens that do not follow the theme (Login is always dark). */
export const inputStyles = {
  light: createInputStyles(lightColors),
  dark: createInputStyles(darkColors),
} as const;

export default inputStyles;
