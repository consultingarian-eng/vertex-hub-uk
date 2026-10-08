/**
 * Pure helper functions for the Manual editor. Extracted from
 * app/(tabs)/manual.tsx so they can be unit-tested and reused by sub-
 * components without import cycles.
 */
import { PRESET_LABELS, PRESET_COLORS, PRESET_FALLBACK_COLOR } from './constants';

/** Returns the human-readable preset label for a given grade_options array.
 *  • undefined / empty array → 'Not Set'
 *  • known combination       → mapped friendly name
 *  • unknown combination     → joined-with-slashes fallback */
export function getPresetLabel(gradeOptions: string[] | undefined): string {
  if (!gradeOptions || gradeOptions.length === 0) return 'Not Set';
  const key = gradeOptions.join(',');
  return PRESET_LABELS[key] || gradeOptions.join(' / ');
}

/** Returns the colour associated with a preset label, or a neutral grey. */
export function getPresetColor(label: string): string {
  return PRESET_COLORS[label] || PRESET_FALLBACK_COLOR;
}

/** Translates a 1-8 DB day number to its UI label.
 *  • Days 1-2 (orientation) → 'Day 1', 'Day 2'
 *  • Days 3-8 (field)       → 'Day 1'..'Day 6' (offset by -2) */
export function getDayLabel(dbDay: number): string {
  if (dbDay <= 2) return `Day ${dbDay}`;
  return `Day ${dbDay - 2}`;
}

/** On-screen word for a stored grade value. Vertex is self-employed, so the
 *  Day 8 "Promote" outcome reads "Advance" (the owner's terminology guide).
 *  Display only — the stored grade value is never changed. */
const GRADE_DISPLAY: Record<string, string> = {
  Promote: 'Advance',
};
export function displayGrade(grade: string | null | undefined): string {
  const g = grade || '';
  return GRADE_DISPLAY[g] || g;
}
