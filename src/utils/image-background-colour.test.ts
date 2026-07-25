import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { calculateImageBackgroundColour } from './image-background-colour';

describe('calculateImageBackgroundColour', () => {
  it('keeps an already-light representative colour', async () => {
    const image = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 232, g: 237, b: 244 },
      },
    })
      .png()
      .toBuffer();

    expect(await calculateImageBackgroundColour(image)).toBe('#E8EDF4');
  });

  it('keeps the exact dominant colour instead of lightening it', async () => {
    const image = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
      .png()
      .toBuffer();

    expect(await calculateImageBackgroundColour(image)).toBe('#1E3C5A');
  });

  it('preserves a neutral white background around a coloured logo', async () => {
    const logo = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 25, g: 100, b: 210 },
      },
    })
      .png()
      .toBuffer();
    const image = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([{ input: logo, left: 15, top: 15 }])
      .png()
      .toBuffer();

    expect(await calculateImageBackgroundColour(image)).toBe('#FFFFFF');
  });

  it('falls back to the dominant logo colour when the image edge is transparent', async () => {
    const logo = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 25, g: 100, b: 210, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const image = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: logo, left: 15, top: 15 }])
      .png()
      .toBuffer();

    expect(await calculateImageBackgroundColour(image)).toBe('#1964D2');
  });

  it('composites fully transparent images over white', async () => {
    const image = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    expect(await calculateImageBackgroundColour(image)).toBe('#FFFFFF');
  });

  it('rejects undecodable bytes for the upload hook to handle fail-open', async () => {
    await expect(
      calculateImageBackgroundColour(Buffer.from('not an image')),
    ).rejects.toThrow();
  });
});
