// Tolerant field readers for rows returned by the document service —
// shared by the validation modules that merge partial payloads over stored
// documents. Undefined (never a throw) for anything that is not the exact
// expected shape.

export function readString(row: unknown, key: string): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = Reflect.get(row, key);
  return typeof value === 'string' ? value : undefined;
}

export function readBoolean(row: unknown, key: string): boolean | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = Reflect.get(row, key);
  return typeof value === 'boolean' ? value : undefined;
}
