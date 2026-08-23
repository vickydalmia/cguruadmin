import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CULTURE_GALLERY_IMAGE_OPTIMIZATION,
  IMAGE_BREAKPOINTS,
  IMAGE_OPTIMIZATION,
} from '../../constants/image';
import { CULTURE_GALLERY_MEDIA_FOLDER_NAME } from '../../constants/media-folders';
// Safe as a static import: the extension only touches the `strapi` global
// inside its service functions, never at module load.
import applyExtension from './strapi-server';

// The extension reads the `strapi` global for config and logging.
const logged: { level: string; message: string }[] = [];
(globalThis as any).strapi = {
  config: { get: (_key: string, fallback: unknown) => fallback },
  plugin: () => ({
    service: () => ({
      getSettings: async () => ({ sizeOptimization: true }),
    }),
  }),
  db: {
    query: () => ({
      findOne: async ({ where }: any) =>
        where.id === 42 ? { name: CULTURE_GALLERY_MEDIA_FOLDER_NAME } : null,
    }),
  },
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
  await sharp(png).webp({ quality: IMAGE_OPTIMIZATION.quality }).toFile(masterPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildService(
  baseOverrides: Record<string, any> = {},
  uploadOverrides: Record<string, any> = {},
) {
  const base = {
    isImage: vi.fn(async () => true),
    optimize: vi.fn(),
    generateThumbnail: vi.fn(async () => null),
    generateResponsiveFormats: vi.fn(async () => []),
    isResizableImage: vi.fn(async () => true),
    ...baseOverrides,
  };
  const uploadBase = {
    findOne: vi.fn(async () => ({ id: 100, folder: { id: 42 } })),
    replace: vi.fn(async (_id: string | number, payload: any) => payload),
    ...uploadOverrides,
  };
  const uploadFactory = vi.fn(() => uploadBase);
  const plugin: any = {
    services: { 'image-manipulation': base, upload: uploadFactory },
    contentTypes: {
      file: {
        schema: {
          attributes: {},
        },
      },
    },
  };
  applyExtension(plugin);
  const uploadService = plugin.services.upload({ strapi: (globalThis as any).strapi });
  return {
    service: plugin.services['image-manipulation'],
    base,
    uploadBase,
    uploadFactory,
    uploadService,
    plugin,
  };
}

function webpMaster(cultureGallery = true) {
  return {
    name: 'slug.webp',
    hash: 'slug-a1b2c3d4/slug',
    ext: '.webp',
    mime: 'image/webp',
    filepath: masterPath,
    __sourceFilepath: sourcePath,
    ...(cultureGallery
      ? { __imageOptimizationProfile: 'culture-gallery' }
      : {}),
    tmpWorkingDirectory: tmpDir,
    width: 1600,
    height: 1200,
    sizeInBytes: fs.statSync(masterPath).size,
  };
}

describe('AVIF twin generation', () => {
  it('generates the complete WebP ladder and a size-efficient AVIF ladder', async () => {
    const { service } = buildService();
    const formats = await service.generateResponsiveFormats(webpMaster());
    const keys = formats.map((entry: any) => entry.key).sort();

    expect(keys).toContain('original_avif');
    for (const breakpoint of Object.keys(IMAGE_BREAKPOINTS)) {
      expect(keys).toContain(breakpoint);
    }
    expect(
      keys.some(
        (key: string) => key !== 'original_avif' && key.endsWith('_avif'),
      ),
    ).toBe(true);
    for (const entry of formats.filter((entry: any) => entry.key.endsWith('_avif'))) {
      expect(entry.file.mime).toBe('image/avif');
      expect(entry.file.ext).toBe('.avif');
      expect(entry.file.sizeInBytes).toBeGreaterThan(0);
      expect(fs.existsSync(entry.file.filepath)).toBe(true);
    }
  });

  it('encodes responsive WebPs once from the original upload', async () => {
    const { service, base } = buildService();
    const formats = await service.generateResponsiveFormats(webpMaster());
    const webpFormats = formats.filter((entry: any) => !entry.key.endsWith('_avif'));

    expect(base.generateResponsiveFormats).not.toHaveBeenCalled();
    expect(webpFormats.map((entry: any) => entry.key).sort()).toEqual(
      Object.keys(IMAGE_BREAKPOINTS).sort(),
    );
    for (const entry of webpFormats) {
      expect(entry.file.mime).toBe('image/webp');
      expect(entry.file.ext).toBe('.webp');
      expect(entry.file.sizeInBytes).toBeGreaterThan(0);
      expect(fs.existsSync(entry.file.filepath)).toBe(true);
    }
  });

  it('keeps the existing responsive encoder for media outside the Culture Gallery folder', async () => {
    const { service, base } = buildService();

    await service.generateResponsiveFormats(webpMaster(false));

    expect(base.generateResponsiveFormats).toHaveBeenCalledTimes(1);
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

    const formats = await service.generateResponsiveFormats(webpMaster(false));
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

describe('background colour extraction', () => {
  it('adds the server-managed field to upload.file', () => {
    const { plugin } = buildService();

    expect(plugin.contentTypes.file.schema.attributes.backgroundColour).toEqual({
      type: 'string',
      configurable: false,
      minLength: 7,
      maxLength: 7,
      regex: '^#[0-9A-F]{6}$',
    });
  });

  it('calculates the background once and keeps it through repeated image checks', async () => {
    const imagePath = path.join(tmpDir, 'background-colour.png');
    await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 232, g: 237, b: 244 },
      },
    })
      .png()
      .toFile(imagePath);
    const { service, base } = buildService();
    const file = { name: 'entity.png', filepath: imagePath };

    await service.isImage(file);
    await service.isImage(file);

    expect(file.backgroundColour).toBe('#E8EDF4');
    expect(base.isImage).toHaveBeenCalledTimes(2);
  });

  it('stores null without blocking uploads when extraction fails', async () => {
    logged.length = 0;
    const { service } = buildService();
    const file = {
      name: 'broken.png',
      filepath: path.join(tmpDir, 'missing-background-source'),
    };

    await expect(service.isImage(file)).resolves.toBe(true);
    expect(file.backgroundColour).toBeNull();
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('sets null for non-image replacements', async () => {
    const { service } = buildService({
      isImage: vi.fn(async () => false),
    });
    const file = { name: 'document.pdf', filepath: sourcePath };

    await expect(service.isImage(file)).resolves.toBe(false);
    expect(file.backgroundColour).toBeNull();
  });
});

describe('high-quality WebP master', () => {
  it('caps large photographs at the high-density editorial limit', async () => {
    const largePath = path.join(tmpDir, 'large-photograph.jpg');
    await sharp({
      create: {
        width: 3200,
        height: 2400,
        channels: 3,
        background: { r: 92, g: 135, b: 170 },
      },
    })
      .jpeg({ quality: 96 })
      .toFile(largePath);
    const { service } = buildService();
    const optimized = await service.optimize({
      name: 'culture-team.jpg',
      hash: 'culture_team_abc123',
      ext: '.jpg',
      mime: 'image/jpeg',
      filepath: largePath,
      tmpWorkingDirectory: tmpDir,
      folder: 42,
    });

    expect(optimized.ext).toBe('.webp');
    expect(optimized.mime).toBe('image/webp');
    expect(optimized.width).toBe(
      CULTURE_GALLERY_IMAGE_OPTIMIZATION.maxDimension,
    );
    expect(optimized.height).toBe(1920);
    expect(optimized.__sourceFilepath).toBe(largePath);
    expect(optimized.__imageOptimizationProfile).toBe('culture-gallery');
  });

  it('keeps the lighter default profile outside the Culture Gallery folder', async () => {
    const largePath = path.join(tmpDir, 'standard-large-photograph.jpg');
    await sharp({
      create: {
        width: 3200,
        height: 2400,
        channels: 3,
        background: { r: 92, g: 135, b: 170 },
      },
    })
      .jpeg({ quality: 96 })
      .toFile(largePath);
    const { service } = buildService();
    const optimized = await service.optimize({
      name: 'other-page.jpg',
      hash: 'other_page_abc123',
      ext: '.jpg',
      mime: 'image/jpeg',
      filepath: largePath,
      tmpWorkingDirectory: tmpDir,
    });

    expect(optimized.width).toBe(IMAGE_OPTIMIZATION.maxDimension);
    expect(optimized.height).toBe(1440);
    expect(optimized.__imageOptimizationProfile).toBeUndefined();
  });
});

describe('replacement folder preservation', () => {
  it('carries the existing Culture Gallery folder into replacement optimization', async () => {
    const { uploadService, uploadBase, uploadFactory } = buildService();
    const payload = {
      data: { fileInfo: { name: 'replacement.jpg' } },
      file: { originalFilename: 'replacement.jpg' },
    };

    await uploadService.replace('100', payload, { user: { id: 5 } });

    expect(uploadFactory).toHaveBeenCalledTimes(1);
    expect(uploadBase.findOne).toHaveBeenCalledWith('100', { folder: true });
    expect(uploadBase.replace).toHaveBeenCalledWith(
      '100',
      {
        data: {
          fileInfo: {
            name: 'replacement.jpg',
            folder: 42,
          },
        },
        file: payload.file,
      },
      { user: { id: 5 } },
    );
    expect(payload.data.fileInfo).not.toHaveProperty('folder');
  });

  it('preserves an explicitly supplied replacement folder', async () => {
    const { uploadService, uploadBase } = buildService();
    const payload = {
      data: { fileInfo: { folder: 7 } },
      file: { originalFilename: 'replacement.jpg' },
    };

    await uploadService.replace('100', payload);

    expect(uploadBase.findOne).not.toHaveBeenCalled();
    expect(uploadBase.replace).toHaveBeenCalledWith('100', payload, undefined);
  });

  it('delegates unchanged when the existing asset has no folder', async () => {
    const { uploadService, uploadBase } = buildService({}, {
      findOne: vi.fn(async () => ({ id: 100, folder: null })),
    });
    const payload = {
      data: { fileInfo: {} },
      file: { originalFilename: 'replacement.jpg' },
    };

    await uploadService.replace('100', payload);

    expect(uploadBase.replace).toHaveBeenCalledWith('100', payload, undefined);
  });

  it('preserves the original missing-asset error', async () => {
    const notFound = new Error('asset not found');
    const { uploadService, uploadBase } = buildService({}, {
      findOne: vi.fn(async () => null),
      replace: vi.fn(async () => {
        throw notFound;
      }),
    });
    const payload = {
      data: { fileInfo: {} },
      file: { originalFilename: 'replacement.jpg' },
    };

    await expect(
      uploadService.replace('missing', payload),
    ).rejects.toBe(notFound);
    expect(uploadBase.replace).toHaveBeenCalledWith(
      'missing',
      payload,
      undefined,
    );
  });
});
