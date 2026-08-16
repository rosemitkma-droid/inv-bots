export const theme = {
  bg: 'black',
  fg: 'white',
  dim: '#6b7280',
  accent: 'cyan',
  accent2: 'magentaBright',
  up: 'green',
  upBright: 'greenBright',
  down: 'red',
  downBright: 'redBright',
  warn: 'yellow',
  ok: 'greenBright',
  err: 'redBright',
  muted: '#4b5563',
  border: 'gray',
  value: '#e5e7eb',
  valueDim: '#9ca3af',
  gold: '#f5b301',
  ice: '#7dd3fc',
  violet: '#c4b5fd',
} as const;

export function fmtMoney(n: number, currency = 'USD'): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return `— ${currency}`.trimEnd();
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${abs.toFixed(2)} ${currency}`.trimEnd();
}

export function fmtPrice(n: number | null | undefined, digits = 2): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

/** "MM:SS" countdown helper. Clamps negatives to 00:00. */
export function fmtCountdown(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '00:00';
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
