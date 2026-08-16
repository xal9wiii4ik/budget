// Client-side downscale + JPEG re-encode, run BEFORE the upload.
//
// Why at all: phone photos are 3-12 MB and 4000px wide; the model reads a 1500px
// receipt just as well, the upload is seconds instead of a minute, and the
// server's 10 MiB cap stops being something the user ever meets. It also
// normalises PNG bank screenshots into the JPEG the upload contract expects.
//
// This file is split on purpose: `targetDimensions` is pure and unit-tested,
// while `downscaleToJpeg` touches canvas/createImageBitmap, which jsdom does not
// implement (the web vitest environment is `node`) — orientation and JPEG
// quality are visual properties and belong to web-qa's browser pass.
export const MAX_LONG_SIDE = 1500;
export const JPEG_QUALITY = 0.8;

/**
 * Pre-decode source guard. Not the real limit (the server's parse-time HEAD
 * Content-Length is), just a fast reject so a 40 MB RAW-ish file is refused in
 * milliseconds instead of being decoded into hundreds of MB of bitmap first.
 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export type DownscaleFailure = 'not-an-image' | 'source-too-large' | 'decode-failed' | 'encode-failed';

export class DownscaleError extends Error {
  readonly reason: DownscaleFailure;

  constructor(reason: DownscaleFailure) {
    super(`Image could not be prepared: ${reason}`);
    this.name = 'DownscaleError';
    this.reason = reason;
  }
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Scale so the LONG side is at most `maxLong`, preserving aspect ratio. Never
 * upscales: an image already within the budget passes through untouched (a
 * blown-up 400px screenshot would be bigger bytes and no more legible).
 */
export function targetDimensions(
  width: number,
  height: number,
  maxLong: number = MAX_LONG_SIDE,
): Dimensions {
  const longSide = Math.max(width, height);
  if (longSide <= maxLong) return { width, height };

  const scale = maxLong / longSide;
  return {
    // A 1x20000 sliver would round the short side to 0 and make an unusable
    // canvas, so every side keeps at least one pixel.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decode with EXIF orientation applied, so a photo taken sideways is uploaded
 * upright AND its reported width/height are the oriented ones (which is what
 * `targetDimensions` must see).
 *
 * `createImageBitmap(file, {imageOrientation: 'from-image'})` is the direct way;
 * where the option is unsupported (older Safari) it either throws or is ignored,
 * so we fall back to an <img>, which browsers auto-orient when rendering.
 */
async function decodeImage(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Unsupported option or an unsupported codec — try the <img> path before
      // calling the file undecodable.
    }
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new DownscaleError('decode-failed');
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function encodeJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new DownscaleError('encode-failed'));
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * File -> upload-ready JPEG blob. Throws `DownscaleError`; the flow hook maps
 * the reason to a message and a retry granularity.
 */
export async function downscaleToJpeg(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new DownscaleError('not-an-image');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new DownscaleError('source-too-large');
  }

  const decoded = await decodeImage(file);
  try {
    if (decoded.width === 0 || decoded.height === 0) {
      throw new DownscaleError('decode-failed');
    }
    const { width, height } = targetDimensions(decoded.width, decoded.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new DownscaleError('encode-failed');
    }
    context.drawImage(decoded.source, 0, 0, width, height);
    return await encodeJpeg(canvas);
  } finally {
    decoded.release();
  }
}
