import config from './nvidia-nim-models.json';

export function parseContextWindow(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(number) || number < 4096 || number > 1_000_000) throw new Error('Context window must be an integer between 4096 and 1000000 tokens.');
  return number;
}

/** Documented model maximums are configurable allocations, not a measurement of a hosted/local runtime. */
export function resolveContextWindow({ provider, model, override = '', advertised }: { provider: string; model: string; override?: string; advertised?: number }): number {
  const explicit = parseContextWindow(override);
  if (explicit !== null) return explicit;
  if (Number.isInteger(advertised) && advertised! >= 4096 && advertised! <= 1_000_000) return advertised!;
  return provider === 'nvidia-nim' ? config.models.find(entry => entry.id === model)?.contextWindowTokens ?? 32_768 : 32_768;
}

export function contextOutputTokens(window: number, requested: number): number {
  return Math.max(256, Math.min(requested, Math.floor(window / 4)));
}
