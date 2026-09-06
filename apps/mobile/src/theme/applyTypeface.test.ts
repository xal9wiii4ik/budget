import { describe, expect, it } from 'vitest';

import { applyTypeface } from './applyTypeface';

describe('applyTypeface', () => {
  it('maps each supported weight to its static family and drops fontWeight', () => {
    const out = applyTypeface(
      {
        regular: { fontSize: 15 },
        medium: { fontSize: 15, fontWeight: '500' },
        semiBold: { fontSize: 15, fontWeight: '600' },
        bold: { fontSize: 15, fontWeight: 'bold' },
      },
      true,
    );

    expect(out).toEqual({
      regular: { fontSize: 15, fontFamily: 'Inter_400Regular' },
      medium: { fontSize: 15, fontFamily: 'Inter_500Medium' },
      semiBold: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
      bold: { fontSize: 15, fontFamily: 'Inter_700Bold' },
    });
    // The whole point: a static family plus a weight double-bolds on Android.
    for (const style of Object.values(out)) expect(style).not.toHaveProperty('fontWeight');
  });

  it('snaps an unsupported weight to the nearest loaded family', () => {
    const out = applyTypeface({ thin: { fontWeight: '100' }, black: { fontWeight: '900' } }, true);

    expect(out.thin).toEqual({ fontFamily: 'Inter_400Regular' });
    expect(out.black).toEqual({ fontFamily: 'Inter_700Bold' });
  });

  it('returns the sheet untouched when the fonts failed to load', () => {
    const input = { label: { fontSize: 15, fontWeight: '600' as const } };

    const out = applyTypeface(input, false);

    // Identity, not a copy: the system font is variable and must keep honouring
    // the author's fontWeight.
    expect(out).toBe(input);
    expect(out.label.fontWeight).toBe('600');
  });

  it('passes a style with no font properties through by identity', () => {
    // No colour LITERAL even in a fixture: the close-of-scope grep gate scans
    // all of src for one.
    const row = { flexDirection: 'row', gap: 8 };

    const out = applyTypeface({ row }, true);

    expect(out.row).toBe(row);
  });
});
