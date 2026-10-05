import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyUploadQualityControllers, currentUploadQuality } from './upload-quality';
import { createImageOptimization } from './upload-master-optimization';
import { createResponsiveFormats } from './upload-responsive-formats';

let directory: string;
let source: string;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-quality-'));
  source = path.join(directory, 'source.png');
  await sharp({ create: { width: 4800, height: 1233, channels: 3, background: '#b97236' } }).png().toFile(source);
  vi.stubGlobal('strapi', {
    plugin: () => ({ service: () => ({ getSettings: async () => ({ sizeOptimization: true }) }) }),
    config: { get: (_: string, fallback: unknown) => fallback },
    log: { error: vi.fn() },
  });
});
afterAll(() => { vi.unstubAllGlobals(); fs.rmSync(directory, { recursive: true, force: true }); });

function controller(action: (ctx: any) => unknown) {
  const plugin = { controllers: { 'admin-upload': { uploadFiles: action, replaceFile: action } } };
  applyUploadQualityControllers(plugin);
  return plugin.controllers['admin-upload'];
}
const request = (quality?: unknown) => ({ request: { body: quality === undefined ? {} : { imageQuality: quality } } });

describe('upload quality', () => {
  it('keeps concurrent requests isolated and clears the choice afterward', async () => {
    const handler = controller(async () => {
      const before = currentUploadQuality();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [before, currentUploadQuality()];
    });
    expect(await Promise.all([handler.uploadFiles(request('high')), handler.uploadFiles(request('default')), handler.replaceFile(request())]))
      .toEqual([['high', 'high'], ['default', 'default'], [undefined, undefined]]);
    expect(currentUploadQuality()).toBeUndefined();
  });

  it('rejects unsupported values before processing', () => {
    const action = vi.fn();
    const handler = controller(action);
    expect(() => handler.uploadFiles(request('ultra'))).toThrow('Choose Default or High');
    expect(action).not.toHaveBeenCalled();
  });

  it('caps Default at 1920 and High at 3840 with sharp responsive rungs and full-width AVIF', async () => {
    const optimize = createImageOptimization({ base: {}, isCultureGalleryUpload: async () => false, attachDealImageMetadata: (file) => file }).optimize;
    const formats = createResponsiveFormats({ base: { generateResponsiveFormats: async () => [] } });
    const handler = controller(async (ctx) => {
      const hash = `test_${ctx.request.body.imageQuality}`;
      return optimize({ name: 'banner.png', ext: '.png', mime: 'image/png', filepath: source, hash, tmpWorkingDirectory: directory });
    });
    const standard = await handler.uploadFiles(request('default')) as any;
    const high = await handler.uploadFiles(request('high')) as any;
    expect(standard.width).toBe(1920);
    expect(high.width).toBe(3840);
    expect(high.__imageOptimizationProfile).toBe('high');
    expect(high.__sourceFilepath).toBe(source);
    const variants = await formats.generateResponsiveFormats(high);
    expect(variants.filter((v) => !v.key.endsWith('_avif')).map((v) => v.file.width).sort((a, b) => a - b))
      .toEqual([320, 500, 750, 1000, 1440, 1920, 2880]);
    // Allow the AVIF size guard to run against a guaranteed larger fallback.
    const avif = await formats.generateResponsiveFormats({ ...standard, sizeInBytes: Infinity });
    expect(avif.find((v) => v.key === 'original_avif')?.file.width).toBe(1920);
    expect(currentUploadQuality()).toBeUndefined();
  }, 30000);

  it('does not upscale small originals or override legacy gallery uploads without a choice', async () => {
    const smallSource = path.join(directory, 'small.png');
    await sharp({ create: { width: 600, height: 154, channels: 3, background: '#bc7311' } }).png().toFile(smallSource);
    const optimize = createImageOptimization({ base: {}, isCultureGalleryUpload: async () => true, attachDealImageMetadata: (file) => file }).optimize;
    const handler = controller(() => optimize({ name: 'small.png', mime: 'image/png', filepath: smallSource, hash: 'small', tmpWorkingDirectory: directory }));
    const high = await handler.uploadFiles(request('high')) as any;
    expect(high.width).toBe(600);
    const legacy = await handler.uploadFiles(request()) as any;
    expect(legacy.__imageOptimizationProfile).toBe('culture-gallery');
    const explicitDefault = await handler.uploadFiles(request('default')) as any;
    expect(explicitDefault.__imageOptimizationProfile).toBeUndefined();
  });
});
