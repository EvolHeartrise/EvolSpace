// Number / value formatting for displays. Pure, no allocation beyond the result string.

export const NUMBER_FORMATS = ['auto', 'fixed', 'int', 'sci', 'si', 'percent'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

export interface FormatOptions {
  /**
   * auto:    significant digits = precision; switches to scientific for very large/small
   * fixed:   `precision` decimals
   * int:     rounded integer with thousands separators
   * sci:     scientific with `precision` significant digits
   * si:      SI prefix (k, M, G, m, µ, …) with `precision` significant digits
   * percent: v * 100 with `precision` decimals and '%'
   */
  format?: NumberFormat;
  precision?: number;
  /** Appended after a thin space (omitted for percent). */
  unit?: string;
}

const SI = [
  { e: 12, s: 'T' }, { e: 9, s: 'G' }, { e: 6, s: 'M' }, { e: 3, s: 'k' }, { e: 0, s: '' },
  { e: -3, s: 'm' }, { e: -6, s: 'µ' }, { e: -9, s: 'n' }, { e: -12, s: 'p' },
];

/** Trim trailing zeros of a decimal string ("1.2300" → "1.23", "2.000" → "2"). Leaves exponents intact. */
function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  const [mant, exp] = s.split('e');
  const m = mant.replace(/0+$/, '').replace(/\.$/, '');
  return exp !== undefined ? `${m}e${exp}` : m;
}

function groupThousands(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, frac] = body.split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + g + (frac !== undefined ? '.' + frac : '');
}

export function formatNumber(v: number, opts: FormatOptions = {}): string {
  const fmt = opts.format ?? 'auto';
  const unit = opts.unit ? ` ${opts.unit}` : '';
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return (v > 0 ? '∞' : '-∞') + unit;
  const p = Math.max(0, Math.min(15, Math.round(opts.precision ?? (fmt === 'fixed' || fmt === 'percent' ? 2 : 4))));
  switch (fmt) {
    case 'fixed':
      return v.toFixed(p) + unit;
    case 'int':
      return groupThousands(Math.round(v).toString()) + unit;
    case 'percent':
      return (v * 100).toFixed(p) + '%';
    case 'sci':
      return v.toExponential(Math.max(0, p - 1)) + unit;
    case 'si': {
      if (v === 0) return '0' + unit;
      const a = Math.abs(v);
      const step = SI.find((x) => a >= Math.pow(10, x.e)) ?? SI[SI.length - 1];
      const scaled = v / Math.pow(10, step.e);
      const s = trimZeros(scaled.toPrecision(Math.max(1, p)));
      return `${s}${opts.unit ? ' ' : ''}${step.s}${opts.unit ?? ''}`;
    }
    case 'auto':
    default: {
      if (v === 0) return '0' + unit;
      const a = Math.abs(v);
      if (a >= 1e6 || a < 1e-4) return trimZeros(v.toExponential(Math.max(0, p - 1))) + unit;
      if (Number.isInteger(v)) return groupThousands(v.toString()) + unit;
      // Significant digits, but never more decimals than needed.
      const s = trimZeros(v.toPrecision(Math.max(1, p)));
      return (s.includes('e') ? s : groupThousands(s)) + unit;
    }
  }
}

/** Compact tick label for axis ticks with spacing `step`. */
export function formatTick(v: number, step: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(step);
  if (a >= 1e5 || (a > 0 && a < 1e-3)) return trimZeros(v.toExponential(1));
  const decimals = a >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(a) - 1e-9));
  const s = v.toFixed(decimals);
  return s === '-0' ? '0' : s.replace(/^-0(\.0+)?$/, '0$1');
}

/** Truncate to `max` characters with an ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

/** Human-readable relative age: "now", "3 s", "2 min", "1 h". */
export function formatAge(ms: number): string {
  if (!(ms >= 0)) return '';
  if (ms < 1000) return 'now';
  const s = ms / 1000;
  if (s < 60) return `${Math.floor(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

export function formatBytes(n: number): string {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One-line rendering of any value for labels (numbers formatted, objects JSON, long text truncated). */
export function formatValue(v: unknown, opts: FormatOptions = {}, max = 80): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'number') return formatNumber(v, opts);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return truncate(v, max);
  try {
    return truncate(JSON.stringify(v), max);
  } catch {
    return truncate(String(v), max);
  }
}
