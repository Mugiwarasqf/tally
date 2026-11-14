import { useApp } from '../../app/data';
import { addMonths, cycleLabel } from '../../lib/dates';
import { Icon } from '../icons';

/** Previous / next budget cycle. Limited to the span that has data, plus the coming cycle for planning. */
export function PeriodPill({ allowFuture = true }: { allowFuture?: boolean }) {
  const { viewKey, setViewKey, minKey, maxKey, settings } = useApp();
  const hi = allowFuture ? maxKey : addMonths(maxKey, -1);
  return (
    <div className="period" role="group" aria-label="Budget period">
      <button onClick={() => setViewKey(addMonths(viewKey, -1))} disabled={viewKey <= minKey} aria-label="Previous period">
        <Icon name="CaretLeft" size={16} weight="bold" />
      </button>
      <span className="period__label" aria-live="polite">{cycleLabel(viewKey, settings.monthStartDay)}</span>
      <button onClick={() => setViewKey(addMonths(viewKey, 1))} disabled={viewKey >= hi} aria-label="Next period">
        <Icon name="CaretRight" size={16} weight="bold" />
      </button>
    </div>
  );
}
