import { useMemo, useState } from 'react';
import { useApp } from '../../app/data';
import type { Category, CategoryKind } from '../../domain/types';
import { Icon } from '../icons';
import { CatTile } from './bits';
import { Sheet } from './overlay';

const GROUPS: Array<{ kind: CategoryKind; label: string }> = [
  { kind: 'expense', label: 'Spending' },
  { kind: 'income', label: 'Income' },
  { kind: 'debt', label: 'Debt' },
  { kind: 'saving', label: 'Saving' },
  { kind: 'transfer', label: 'Transfers' },
];

/**
 * Pick a category. Pass `direction` to float the sensible group (income vs spending) to the top
 * without hiding the others — a refund can be spending, a payment can be a transfer.
 */
export function CategorySheet(props: { title?: string; current?: string; direction?: 'in' | 'out'; onPick: (c: Category) => void; onClose: () => void }) {
  const { categories } = useApp();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const order = props.direction === 'in' ? ['income', 'transfer', 'saving', 'debt', 'expense'] : ['expense', 'debt', 'saving', 'transfer', 'income'];
    return [...GROUPS]
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      .map((g) => ({ ...g, items: categories.filter((c) => c.kind === g.kind && c.name.toLowerCase().includes(q.trim().toLowerCase())) }))
      .filter((g) => g.items.length);
  }, [categories, q, props.direction]);

  return (
    <Sheet title={props.title ?? 'Choose a category'} onClose={props.onClose}>
      <div className="search">
        <Icon name="MagnifyingGlass" size={18} />
        <input className="input" placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search categories" />
      </div>
      {groups.map((g) => (
        <div key={g.kind} className="stack stack--sm">
          <span className="t-eyebrow">{g.label}</span>
          <div className="menu">
            {g.items.map((c) => (
              <button key={c.id} className="menu__item" aria-selected={props.current === c.id} onClick={() => props.onPick(c)}>
                <CatTile cat={c} size="sm" />
                <span className="grow">{c.name}</span>
                {props.current === c.id && <Icon name="Check" size={18} weight="bold" />}
              </button>
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <p className="t-small">No category matches “{q}”.</p>}
    </Sheet>
  );
}
