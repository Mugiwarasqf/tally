/**
 * Where the user banks. One region per device (like YNAB's per-plan currency), chosen on first run and
 * changeable in Settings. It sets the currency sign, how ambiguous dates like 03/04 are read, and the scale of
 * "small" and "big" amounts used by heuristics (a £5 coffee is roughly a ₦5,000 one).
 *
 * The active region is module state, set once from Settings by the app shell. `fmt` and the heuristics read it,
 * so the 250-odd call sites need no extra argument. Tests start in the UK and can switch with `setRegion`.
 */
export type RegionId = 'uk' | 'ng' | 'us';

export interface Region {
  id: RegionId;
  name: string;
  currency: 'GBP' | 'NGN' | 'USD';
  symbol: string;
  /** Word for the currency in sentences ("pounds"). */
  unitName: string;
  /** How ambiguous numeric dates (03/04/26) are read when the statement itself doesn't settle it. */
  dateOrder: 'dmy' | 'mdy';
  /**
   * Rough size of everyday amounts compared with the UK, as a power of ten so thresholds stay round numbers:
   * a "small purchase" is under £5, $5 or ₦5,000. Only used by heuristics, never to convert money.
   */
  scale: number;
}

export const REGIONS: Record<RegionId, Region> = {
  uk: { id: 'uk', name: 'United Kingdom', currency: 'GBP', symbol: '£', unitName: 'pounds', dateOrder: 'dmy', scale: 1 },
  ng: { id: 'ng', name: 'Nigeria', currency: 'NGN', symbol: '₦', unitName: 'naira', dateOrder: 'dmy', scale: 1000 },
  us: { id: 'us', name: 'United States', currency: 'USD', symbol: '$', unitName: 'dollars', dateOrder: 'mdy', scale: 1 },
};

let active: Region = REGIONS.uk;

export const region = (): Region => active;

export function setRegion(id: RegionId | undefined): Region {
  active = REGIONS[id ?? 'uk'] ?? REGIONS.uk;
  return active;
}

/**
 * An everyday amount in the active currency, in minor units: `everyday(5)` is £5 (500), $5 or ₦5,000.
 * For thresholds such as "small purchase" or "moved by more than", never for converting money.
 */
export const everyday = (units: number): number => Math.round(units * 100 * active.scale);
