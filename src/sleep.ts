export function sleep(ms: number, signal: AbortSignal, poke?: { wake: (() => void) | null }): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      if (poke) poke.wake = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (poke) poke.wake = done;
  });
}
