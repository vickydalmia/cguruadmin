import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, uniqueFileNames } from './zip';

describe('campaign ZIP', () => {
  it('stores every file with a valid checksum and directory', () => {
    const zip = buildZip([{ name: 'a.csv', content: 'héllo' }, { name: 'b.csv', content: 'world' }], new Date(2026, 10, 21, 10, 30));
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const size = view.getUint32(22, true);
    const data = zip.slice(35, 35 + size);
    expect(new TextDecoder().decode(data)).toBe('héllo');
    expect(view.getUint32(14, true)).toBe(crc32(data));
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 12, true)).toBe(2);
  });

  it('keeps files whose names collide', () => {
    expect(uniqueFileNames(['a.csv', 'A.csv', 'a.csv', 'b.csv'])).toEqual(['a.csv', 'A-2.csv', 'a-3.csv', 'b.csv']);
  });
});
