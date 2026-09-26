const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Decimal ratio → percentage rounded to 2 dp (0.1234 → 12.34). Null-safe. */
export function pct(ratio: number | null | undefined): number | null {
  return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? null : round(ratio * 100, 2);
}

/** Indian-style currency string, e.g. ₹1,23,45,678. Helps the LLM quote amounts correctly. */
export function formatInr(amount: number): string {
  return inr.format(Math.round(amount));
}
