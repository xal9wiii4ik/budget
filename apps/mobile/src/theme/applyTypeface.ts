// The RN gotcha this whole scope had to design around: a STATIC font family
// ignores `fontWeight`. Inter ships here as four separate TTFs
// (@expo-google-fonts/inter), so the weight IS the family name — setting both
// double-bolds on Android and is ignored on iOS.
//
// So authors keep writing `fontWeight: '600'` in a `themedStyles` factory, and
// this pure pass rewrites the sheet before `StyleSheet.create` sees it. Pure
// and RN-free by design: it is the half of the typeface story a Node test can
// pin (`applyTypeface.test.ts`), and no react-native module may enter that graph.

/** The four weights the app actually uses; also the loadAsync keys (`fonts.ts`). */
export const INTER_FAMILY = {
  400: 'Inter_400Regular',
  500: 'Inter_500Medium',
  600: 'Inter_600SemiBold',
  700: 'Inter_700Bold',
} as const;

const SUPPORTED_WEIGHTS = [400, 500, 600, 700] as const;

type SupportedWeight = (typeof SUPPORTED_WEIGHTS)[number];

function toNumericWeight(weight: unknown): number {
  if (typeof weight === 'number') return weight;
  if (weight === 'bold') return 700;
  if (weight === 'normal' || weight === undefined || weight === null) return 400;
  if (typeof weight === 'string') {
    const parsed = Number(weight);
    return Number.isFinite(parsed) ? parsed : 400;
  }
  return 400;
}

/**
 * Maps a CSS weight onto one of the four loaded families. Anything outside the
 * set snaps to the NEAREST of the four (a tie goes to the lighter one) — we
 * only ship four files, and a missing family renders as the system font, which
 * would be a silent typeface change rather than a slightly wrong weight.
 */
export function interFamilyForWeight(weight: unknown): string {
  const numeric = toNumericWeight(weight);
  let best: SupportedWeight = 400;
  for (const candidate of SUPPORTED_WEIGHTS) {
    if (Math.abs(candidate - numeric) < Math.abs(best - numeric)) best = candidate;
  }
  return INTER_FAMILY[best];
}

function isTextEntry(entry: Record<string, unknown>): boolean {
  return 'fontSize' in entry || 'fontWeight' in entry;
}

/**
 * Rewrites every TEXT style of a sheet to `fontFamily`, DELETING `fontWeight`.
 *
 * - `fontsLoaded === false` returns the whole object unchanged (by identity):
 *   the system font is variable and must keep honouring the author's weight —
 *   that is the failure arm of the font decision, not a degraded one.
 * - An entry with neither `fontSize` nor `fontWeight` (a pure layout or colour
 *   style) is returned by identity too — no allocation, no behaviour change.
 * - Everything else gets `fontFamily` for `fontWeight ?? '400'`, and loses
 *   `fontWeight`.
 *
 * AUTHORING RULE that falls out of the last point: an OVERRIDE entry layered on
 * a weighted base (`style={[styles.label, styles.labelSm]}`) must repeat the
 * weight if it touches `fontSize` at all — otherwise it resolves to Regular and
 * un-bolds what it was only meant to resize. A colour-only override is safe:
 * it has no font property, so it is passed through untouched.
 */
export function applyTypeface<T extends object>(styles: T, fontsLoaded: boolean): T {
  if (!fontsLoaded) return styles;

  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(styles)) {
    const style = entry as Record<string, unknown>;
    if (!isTextEntry(style)) {
      result[name] = entry;
      continue;
    }
    const { fontWeight, ...rest } = style;
    result[name] = { ...rest, fontFamily: interFamilyForWeight(fontWeight) };
  }
  return result as T;
}
