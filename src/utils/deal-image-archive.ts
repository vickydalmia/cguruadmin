// Deal-image ARCHIVE HANDLING: atomic writes and validation of the
// permanent prepared-PNG archive. One of the modules split out of
// deal-image-background.ts.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DealImageProcessingError } from './deal-image-errors';
import { validateTransparentDealPng } from './deal-image-transparency';

export const sha256 = (value: Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const safeFileStem = (fileName: string): string => {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  return (
    stem
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'deal-image'
  );
};

export async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto
    .randomBytes(6)
    .toString('hex')}`;
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (cause) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause,
    });
  }
}

export async function readValidPermanentArchive(
  outputDirectory: string,
  sourceHash: string,
  fileName: string,
  allowLegacyFileNameArchive: boolean,
): Promise<{
  png: Buffer;
  pngPath: string;
  width: number;
  height: number;
  matchedSourceHash: boolean;
} | null> {
  let names: string[];
  try {
    names = await fs.readdir(outputDirectory);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause: error,
    });
  }

  const canonicalName = `${sourceHash}.png`;
  const hashCandidates = [
    canonicalName,
    ...names
      .filter(
        (name) =>
          name.startsWith(`${sourceHash}-`) &&
          name.toLowerCase().endsWith('.png'),
      )
      .sort(),
  ];
  const legacySuffix = `-${safeFileStem(fileName)}.png`;
  const legacyNameCandidates = allowLegacyFileNameArchive
    ? names.filter((name) => name.endsWith(legacySuffix)).sort()
    : [];
  const candidates = [
    ...[...new Set(hashCandidates)].map((name) => ({
      name,
      matchedSourceHash: true,
    })),
    ...(legacyNameCandidates.length === 1
      ? [{ name: legacyNameCandidates[0]!, matchedSourceHash: false }]
      : []),
  ];
  for (const { name, matchedSourceHash } of candidates) {
    const candidatePath = path.join(outputDirectory, name);
    try {
      const png = await fs.readFile(candidatePath);
      const dimensions = await validateTransparentDealPng(png);
      return {
        png,
        pngPath: candidatePath,
        ...dimensions,
        matchedSourceHash,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      await fs.rm(candidatePath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}
