import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IMAGE_BREAKPOINTS } from '../../constants/image';
// Safe as a static import: the extension only touches the `strapi` global
// inside its service functions, never at module load.
import applyExtension from './strapi-server';

// The extension reads the `strapi` global for config and logging.
const logged: { level: string; message: string }[] = [];
(globalThis as any).strapi = {
  config: { get: (_key: string, fallback: unknown) => fallback },
  log: {
    warn: (message: string) => logged.push({ level: 'warn', message }),
    error: (message: string) => logged.push({ level: 'error', message }),
    info: () => {},
  },
};

let tmpDir: string;
let masterPath: string;
let sourcePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avif-twin-test-'));
  // A real, compressible image large enough that every breakpoint applies.
  const png = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: { r: 180, g: 60, b: 120 },
    },
  })
    .png()
    .toBuffer();
  sourcePath = path.join(tmpDir, 'source-input');
  fs.writeFileSync(sourcePath, png);
  masterPath = path.join(tmpDir, 'optimized-slug');
  await sharp(png).webp({ quality: 80 }).toFile(masterPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildService(baseOverrides: Record<string, any> = {}) {
  const base = {
    optimize: vi.fn(),
    generateThumbnail: vi.fn(async () => null),
    generateResponsiveFormats: vi.fn(async () => []),
    isResizableImage: vi.fn(async () => true),
    ...baseOverrides,
  };
  const plugin: any = { services: { 'image-manipulation': base } };
  applyExtension(plugin);
  return { service: plugin.services['image-manipulation'], base };
}

function webpMaster() {
  return {
    name: 'slug.webp',
    hash: 'slug-a1b2c3d4/slug',
    ext: '.webp',
    mime: 'image/webp',
    filepath: masterPath,
    __sourceFilepath: sourcePath,
    tmpWorkingDirectory: tmpDir,
    width: 1600,
    height: 1200,
    sizeInBytes: fs.statSync(masterPath).size,
  };
}

describe('AVIF twin generation', () => {
  it('generates a twin for the original and every applicable breakpoint', async () => {
    const { service } = buildService();
    const formats = await service.generateResponsiveFormats(webpMaster());
    const keys = formats.map((entry: any) => entry.key).sort();

    expect(keys).toContain('original_avif');
    for (const breakpoint of Object.keys(IMAGE_BREAKPOINTS)) {
      expect(keys).toContain(`${breakpoint}_avif`);
    }
    for (const entry of formats) {
      expect(entry.file.mime).toBe('image/avif');
      expect(entry.file.ext).toBe('.avif');
      expect(entry.file.sizeInBytes).toBeGreaterThan(0);
      expect(fs.existsSync(entry.file.filepath)).toBe(true);
    }
  });

  it('still generates twins when the concurrent master upload deletes filepath', async () => {
    // THE REGRESSION. uploadImage starts provider.upload(master) without
    // awaiting it, and provider.upload deletes file.filepath on completion.
    // That happens *during* the base call below, so the guard used to see a
    // filepath-less file and silently skip every twin.
    const { service } = buildService({
      generateResponsiveFormats: vi.fn(async (file: any) => {
        delete file.filepath;
        return [];
      }),
    });

    const formats = await service.generateResponsiveFormats(webpMaster());
    const keys = formats.map((entry: any) => entry.key);

    expect(keys).toContain('original_avif');
    expect(keys.length).toBeGreaterThan(1);
  });

  it('skips twins loudly when no source file is readable', async () => {
    logged.length = 0;
    const { service } = buildService();
    const file = webpMaster();
    file.filepath = path.join(tmpDir, 'does-not-exist');
    file.__sourceFilepath = path.join(tmpDir, 'also-missing');

    const formats = await service.generateResponsiveFormats(file);

    expect(formats).toEqual([]);
    expect(logged.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('leaves non-webp masters untouched', async () => {
    const { service } = buildService();
    const file = { ...webpMaster(), mime: 'image/gif', ext: '.gif' };
    const formats = await service.generateResponsiveFormats(file);
    expect(formats).toEqual([]);
  });
});
