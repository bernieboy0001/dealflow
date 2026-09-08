/** USDC-style 6-decimal money. All amounts are bigints in atomic (micro) units. */

export const USD_SCALE = 6n;
export const UNIT = 10n ** USD_SCALE; // 1 USDC in micros

/** Asset quantities are stored at the same 6-decimal scale (e.g. 0.85 BTC = 850000). */
export const ASSET_UNIT = 10n ** 6n;

export function parseMicro(value: string): bigint {
  const s = value.trim();
  const neg = s.startsWith('-');
  const clean = neg ? s.slice(1) : s;
  const [whole = '0', frac = ''] = clean.split('.');
  const fracPadded = `${frac}000000`.slice(0, 6);
  const out = BigInt(whole) * UNIT + BigInt(fracPadded);
  return neg ? -out : out;
}

export function parseAssetMicro(value: string): bigint {
  const s = value.trim();
  const neg = s.startsWith('-');
  const clean = neg ? s.slice(1) : s;
  const [whole = '0', frac = ''] = clean.split('.');
  const fracPadded = `${frac}000000`.slice(0, 6);
  const out = BigInt(whole) * ASSET_UNIT + BigInt(fracPadded);
  return neg ? -out : out;
}

export function toMicro(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000));
}

export function toDecimal(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / UNIT;
  const frac = (a % UNIT).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function toAssetDecimal(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / ASSET_UNIT;
  const frac = (a % ASSET_UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Multiply a micro price by (1 + bps/10000), floor'ing for buys (conservative), ceil'ing for sells. */
export function applyBps(priceMicro: bigint, bps: number, side: 'buy' | 'sell'): bigint {
  const b = BigInt(bps);
  const num = priceMicro * (10_000n + b);
  const den = 10_000n;
  if (side === 'buy') return num / den; // allowed to pay up to (floor keeps us at-or-below cap)
  return num % den === 0n ? num / den : num / den + 1n;
}

/** qty (6dp asset units) for a notional budget (6dp dollars): floor so cost <= budget. */
export function quantityFromNotional(notionalAtomic: bigint, priceMicro: bigint): bigint {
  if (priceMicro <= 0n) throw new Error('quantityFromNotional: zero price');
  return (notionalAtomic * ASSET_UNIT) / priceMicro;
}

/** notional in 6dp dollars of a qty (6dp asset units) at a micro price-per-unit. */
export function notionalOf(quantity: bigint, priceMicro: bigint): bigint {
  return (quantity * priceMicro) / ASSET_UNIT;
}
