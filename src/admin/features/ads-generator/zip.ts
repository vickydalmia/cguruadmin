/**
 * Minimal ZIP writer for the "Download all" button. CSV files are small, so
 * entries are stored uncompressed and the admin bundle needs no ZIP library.
 */

export type ZipFile = { name: string; content: string };

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Different campaign names can produce the same file name; keep every file. */
export function uniqueFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) candidate = `${stem}-${copy}${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function header(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

export function buildZip(files: ZipFile[], date: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const UTF8_NAMES = 0x0800;
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  uniqueFileNames(files.map((file) => file.name)).forEach((fileName, index) => {
    const name = encoder.encode(fileName);
    const data = encoder.encode(files[index].content);
    const crc = crc32(data);
    const common = (view: DataView, at: number) => {
      view.setUint16(at, 20, true);
      view.setUint16(at + 2, UTF8_NAMES, true);
      view.setUint16(at + 4, 0, true);
      view.setUint16(at + 6, time, true);
      view.setUint16(at + 8, day, true);
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, data.length, true);
      view.setUint32(at + 18, data.length, true);
      view.setUint16(at + 22, name.length, true);
    };
    const start = offset;
    const localHeader = header(30, (view) => { view.setUint32(0, 0x04034b50, true); common(view, 4); });
    local.push(localHeader, name, data);
    offset += localHeader.length + name.length + data.length;
    central.push(header(46, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      common(view, 6);
      view.setUint32(42, start, true);
    }), name);
  });

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
  });
  const parts = [...local, ...central, end];
  const zip = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) { zip.set(part, cursor); cursor += part.length; }
  return zip;
}
