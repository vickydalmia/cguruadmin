/**
 * Hand a Blob to the browser as a file download.
 *
 * The admin build has no asset pipeline and the server never writes export
 * files to disk, so every download the panel offers is generated in the
 * browser and delivered through a transient object URL. Callers prepend the
 * UTF-8 BOM themselves when the file is CSV, so Excel opens it as UTF-8.
 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
