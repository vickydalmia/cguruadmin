import sharp, { type SharpOptions } from 'sharp';

const SAMPLE_SIZE = 64;
const WHITE = 255;
const RGB_CHANNEL_COUNT = 3;
const RGBA_CHANNEL_COUNT = 4;
const ALPHA_CHANNEL = 3;
const MIN_VISIBLE_ALPHA = 16;
const QUANTIZATION_SHIFT = 4;
const BORDER_RATIO = 0.1;

export type ImageBackgroundInput = Buffer | string;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(WHITE, Math.round(value)));
}

interface ColourBucket {
  weight: number;
  red: number;
  green: number;
  blue: number;
}

function dominantColour(
  pixels: Buffer,
  channels: number,
  width: number,
  height: number,
  borderOnly: boolean,
): [number, number, number] | null {
  if (channels < RGBA_CHANNEL_COUNT) {
    throw new Error('Image did not produce RGBA pixel data');
  }

  const buckets = new Map<number, ColourBucket>();
  for (let offset = 0; offset + channels <= pixels.length; offset += channels) {
    const pixelIndex = offset / channels;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (borderOnly) {
      const borderSize = Math.max(
        1,
        Math.floor(Math.min(width, height) * BORDER_RATIO),
      );
      const isBorder =
        x < borderSize ||
        x >= width - borderSize ||
        y < borderSize ||
        y >= height - borderSize;
      if (!isBorder) continue;
    }

    const alpha = pixels[offset + ALPHA_CHANNEL];
    if (alpha < MIN_VISIBLE_ALPHA) continue;

    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];

    const key =
      ((red >> QUANTIZATION_SHIFT) << 8) |
      ((green >> QUANTIZATION_SHIFT) << 4) |
      (blue >> QUANTIZATION_SHIFT);
    const weight = alpha / WHITE;
    const bucket = buckets.get(key) ?? {
      weight: 0,
      red: 0,
      green: 0,
      blue: 0,
    };
    bucket.weight += weight;
    bucket.red += red * weight;
    bucket.green += green * weight;
    bucket.blue += blue * weight;
    buckets.set(key, bucket);
  }

  let dominant: ColourBucket | null = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.weight > dominant.weight) {
      dominant = bucket;
    }
  }

  return dominant
    ? [
        dominant.red / dominant.weight,
        dominant.green / dominant.weight,
        dominant.blue / dominant.weight,
      ]
    : null;
}

function toHex(colour: readonly number[]): string {
  return `#${colour
    .map((channel) => clampChannel(channel).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/**
 * Calculates the visible background colour without lightening it. The
 * dominant edge colour wins, including white; transparent edges fall back to
 * the dominant visible image colour. Only the first animated frame is sampled.
 */
export async function calculateImageBackgroundColour(
  input: ImageBackgroundInput,
): Promise<string> {
  const inputOptions: SharpOptions = { page: 0, pages: 1 };
  const { data, info } = await sharp(input, inputOptions)
    .rotate()
    .resize({
      width: SAMPLE_SIZE,
      height: SAMPLE_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const colour =
    dominantColour(data, info.channels, info.width, info.height, true) ??
    dominantColour(data, info.channels, info.width, info.height, false) ??
    ([WHITE, WHITE, WHITE] as const);
  return toHex(colour.slice(0, RGB_CHANNEL_COUNT));
}
