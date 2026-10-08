/**
 * Constants for the Training Manual editor — preset grade types, day
 * groupings (Orientation vs Field), and the colour palette used for the
 * grade picker. Extracted from app/(tabs)/manual.tsx to keep the screen
 * file lean.
 */
import { colors } from '../theme/colors';

/* Maps a comma-joined grade-options string to a human label. The order of
 * the options matters because the API stores grade_options as an array. */
export const PRESET_LABELS: Record<string, string> = {
  '10,9,8,7,6,5,4,3,2,1': '1-10',
  'Competent,Learnt,Not Learnt': 'Competent / Learnt / Not Learnt',
  'Learnt,Not Learnt': 'Learnt / Not Learnt',
  'Excellent,Average,Below Average': 'Excellent / Average / Below Average',
};

/* Visual colour for each preset label (badge dot + chip border). Falls back
 * to neutral text colour for unknown presets. */
export const PRESET_COLORS: Record<string, string> = {
  '1-10': '#2F6A4B',
  'Competent / Learnt / Not Learnt': '#059669',
  'Learnt / Not Learnt': '#2563EB',
  'Excellent / Average / Below Average': '#D97706',
};

export const PRESET_FALLBACK_COLOR = colors.textSecondary;

/* Day groupings (DB-day numbering, 1-indexed). Days 1-2 = orientation,
 * 3-8 = field. UI labels them "Day 1, Day 2" and "Day 1..Day 6" respectively. */
export const ORIENTATION_DAYS: number[] = [1, 2];
export const FIELD_DAYS: number[] = [3, 4, 5, 6, 7, 8];
export const ALL_DAYS: number[] = [...ORIENTATION_DAYS, ...FIELD_DAYS];
