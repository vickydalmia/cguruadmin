/** Database publication has a stricter budget than network/provider work. */
let tail: Promise<void> = Promise.resolve();

export async function withLocalePublication<T>(work: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}
