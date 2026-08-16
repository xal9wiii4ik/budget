import { describe, expect, it } from 'vitest';

import { MAX_LONG_SIDE, targetDimensions } from './downscale';

describe('targetDimensions', () => {
  it('scales a landscape photo by its WIDTH', () => {
    expect(targetDimensions(4000, 3000)).toEqual({ width: MAX_LONG_SIDE, height: 1125 });
  });

  it('scales a portrait photo by its HEIGHT (the other long side)', () => {
    // The contrast with the case above: same numbers transposed must pick the
    // other axis, which is exactly what a phone receipt photo needs.
    expect(targetDimensions(3000, 4000)).toEqual({ width: 1125, height: MAX_LONG_SIDE });
  });

  it('never upscales an image that already fits', () => {
    expect(targetDimensions(800, 600)).toEqual({ width: 800, height: 600 });
    // Exact boundary: no scaling, no off-by-one rounding.
    expect(targetDimensions(MAX_LONG_SIDE, 900)).toEqual({ width: MAX_LONG_SIDE, height: 900 });
  });

  it('keeps at least one pixel on the short side of an extreme sliver', () => {
    // Naive rounding gives height 0 here, which makes an unusable canvas.
    expect(targetDimensions(30_000, 5)).toEqual({ width: MAX_LONG_SIDE, height: 1 });
  });

  it('honours a caller-supplied budget', () => {
    expect(targetDimensions(1000, 500, 200)).toEqual({ width: 200, height: 100 });
  });
});
