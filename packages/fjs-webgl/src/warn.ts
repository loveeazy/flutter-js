// The module's own warn-once: same `[fjs]` prefix discipline as the runtime's
// canvas warnings, but keyed separately so installing or omitting this module
// never changes what the 2d path has already said.
const seen = new Set<string>();

export function warnWebglOnce(key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(`[fjs] ${message}`);
}

/** Test hook. */
export function resetWebglWarnings(): void {
  seen.clear();
}
