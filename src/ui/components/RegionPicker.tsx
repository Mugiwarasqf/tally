import { saveSettings } from '../../data/settings';
import { REGIONS } from '../../lib/region';
import type { RegionId } from '../../lib/region';
import { Segmented } from './bits';

const OPTIONS: Array<{ value: RegionId; label: string }> = [
  { value: 'uk', label: 'UK · £' },
  { value: 'ng', label: 'Nigeria · ₦' },
  { value: 'us', label: 'US · $' },
];

/** A first guess from the device's time zone. Read locally; nothing is looked up online. */
export function guessRegion(): RegionId {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    if (tz === 'Africa/Lagos') return 'ng';
    if (tz.startsWith('America/') || tz.startsWith('US/') || tz === 'Pacific/Honolulu') return 'us';
  } catch {
    /* fall through */
  }
  return 'uk';
}

/**
 * Where the user banks. Changing it never converts amounts: it changes the currency sign, how dates such as
 * 03/04 are read, and which banks and shops Tally recognises. With data already loaded, the page reloads so
 * every total and suggestion is worked out again in the new currency.
 */
export function RegionPicker({ value, reload }: { value: RegionId; reload?: boolean }) {
  return (
    <Segmented<RegionId>
      label="Where you bank" value={value} wrap options={OPTIONS}
      onChange={async (v) => {
        if (v === value) return;
        await saveSettings({ region: v });
        if (reload) location.reload();
      }}
    />
  );
}

export const regionLine = (id: RegionId): string => {
  const r = REGIONS[id];
  return `Amounts in ${r.unitName} (${r.symbol}); dates like 03/04 read as ${r.dateOrder === 'mdy' ? 'March 4' : '3 April'}.`;
};
