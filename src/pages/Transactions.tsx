import { useMemo, useState } from 'react';
import { useApp } from '../app/data';
import { useRoute, navigate } from '../app/router';
import { confirmTxns, setCategory, setCategoryMany, setNote } from '../data/actions';
import { REVIEW_THRESHOLD } from '../domain/categorize/engine';
import type { Category, Txn } from '../domain/types';
import { cycleLabel, cycleRange, diffDays, fmtFull } from '../lib/dates';
import { fmt } from '../lib/money';
import { Banner, CatTile, Empty, Segmented } from '../ui/components/bits';
import { CategorySheet } from '../ui/components/CategoryPicker';
import { PinRecurringSheet } from '../ui/components/PinRecurring';
import { Sheet, useToast } from '../ui/components/overlay';
import { Icon } from '../ui/icons';

const PAGE = 80;

export function Transactions() {
  const app = useApp();
  const { params } = useRoute();
  const { txns, catMap, accounts, settings, categories } = app;
  const tab = params.get('review') ? 'review' : params.get('by') === 'merchant' ? 'merchants' : 'all';
  const cycleParam = params.get('cycle');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all');
  const [account, setAccount] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Txn | null>(null);
  const catFilter = params.get('cat') ?? 'all';

  const range = cycleParam ? cycleRange(cycleParam, settings.monthStartDay) : null;
  const needsReview = useMemo(() => txns.filter((t) => t.confidence < REVIEW_THRESHOLD && !t.reviewed && t.catSource !== 'manual'), [txns]);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null || v === 'all') next.delete(k); else next.set(k, v);
    navigate('/transactions', Object.fromEntries(next));
  };
  const go = (t: typeof tab) => {
    const next = new URLSearchParams(params);
    next.delete('review'); next.delete('by');
    if (t === 'review') next.set('review', '1');
    if (t === 'merchants') next.set('by', 'merchant');
    navigate('/transactions', Object.fromEntries(next));
  };

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return txns.filter((t) => {
      if (range && (t.date < range.start || t.date > range.end)) return false;
      if (catFilter !== 'all' && t.categoryId !== catFilter) return false;
      if (account !== 'all' && t.accountId !== account) return false;
      if (dir === 'in' && t.amount <= 0) return false;
      if (dir === 'out' && t.amount >= 0) return false;
      if (needle && !`${t.merchant} ${t.raw} ${t.note ?? ''} ${catMap.get(t.categoryId)?.name ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [txns, q, dir, account, catFilter, range, catMap]);

  const days = useMemo(() => {
    const g = new Map<string, Txn[]>();
    for (const t of list.slice(0, limit)) (g.get(t.date) ?? g.set(t.date, []).get(t.date)!).push(t);
    return [...g.entries()];
  }, [list, limit]);

  return (
    <>
      <div className="page__head">
        <div className="tabs" role="tablist" aria-label="Transactions view">
          <button role="tab" aria-selected={tab === 'all'} onClick={() => go('all')}>All activity</button>
          <button role="tab" aria-selected={tab === 'merchants'} onClick={() => go('merchants')}>By merchant</button>
          <button role="tab" aria-selected={tab === 'review'} onClick={() => go('review')}>
            To review{needsReview.length > 0 && <span className="chip chip--serious" style={{ marginLeft: 8, height: '1.4rem' }}>{needsReview.length}</span>}
          </button>
        </div>
      </div>

      {tab === 'review' ? (
        <ReviewQueue items={needsReview} />
      ) : tab === 'merchants' ? (
        <ReviewQueue items={txns} all />
      ) : (
        <>
          <div className="filters">
            <div className="search">
              <Icon name="MagnifyingGlass" size={18} />
              <input className="input" placeholder="Search merchant, note or category" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} aria-label="Search transactions" />
            </div>
            <select className="select filters__select" value={catFilter} onChange={(e) => setParam('cat', e.target.value)} aria-label="Category">
              <option value="all">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {accounts.length > 1 && (
              <select className="select filters__select" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
                <option value="all">All accounts</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <Segmented label="Direction" value={dir} onChange={setDir} options={[{ value: 'all', label: 'All' }, { value: 'out', label: 'Out' }, { value: 'in', label: 'In' }]} />
          </div>

          {(range || catFilter !== 'all') && (
            <div className="cluster">
              {range && <button className="chip chip--btn" onClick={() => setParam('cycle', null)}>{cycleLabel(cycleParam!, settings.monthStartDay)}<Icon name="X" size={12} weight="bold" /></button>}
              {catFilter !== 'all' && <button className="chip chip--btn" onClick={() => setParam('cat', null)}>{catMap.get(catFilter)?.name}<Icon name="X" size={12} weight="bold" /></button>}
            </div>
          )}

          {list.length === 0 ? (
            <section className="card"><Empty icon="MagnifyingGlass" title="No transactions match">Try clearing a filter or searching for something else.</Empty></section>
          ) : (
            <section className="card">
              <div className="split">
                <span className="t-small">{list.length.toLocaleString('en-GB')} transactions</span>
                <span className="t-small num">
                  In {fmt(list.filter((t) => t.amount > 0 && catMap.get(t.categoryId)?.kind !== 'transfer').reduce((s, t) => s + t.amount, 0), { whole: true })} · Out {fmt(-list.filter((t) => t.amount < 0 && catMap.get(t.categoryId)?.kind !== 'transfer').reduce((s, t) => s + t.amount, 0), { whole: true })}
                </span>
              </div>
              {days.map(([date, rows]) => {
                const net = rows.filter((t) => catMap.get(t.categoryId)?.kind !== 'transfer').reduce((s, t) => s + t.amount, 0);
                return (
                  <div key={date} className="day">
                    <div className="group-head">
                      <span className="t-label">{fmtFull(date)}{diffDays(date, app.today) <= 1 && <span className="muted"> · {diffDays(date, app.today) === 0 ? 'Today' : 'Yesterday'}</span>}</span>
                      <span className="t-xs num">{fmt(net, { sign: true })}</span>
                    </div>
                    <div className="list">
                      {rows.map((t) => <TxnRow key={t.id} t={t} cat={catMap.get(t.categoryId)} onOpen={() => setOpen(t)} />)}
                    </div>
                  </div>
                );
              })}
              {list.length > limit && <button className="btn btn--secondary" onClick={() => setLimit(limit + PAGE)}>Show more ({(list.length - limit).toLocaleString('en-GB')} left)</button>}
            </section>
          )}
        </>
      )}
      {open && <TxnSheet txn={txns.find((t) => t.id === open.id) ?? open} onClose={() => setOpen(null)} />}
    </>
  );
}

function TxnRow({ t, cat, onOpen }: { t: Txn; cat: Category | undefined; onOpen: () => void }) {
  const low = t.confidence < REVIEW_THRESHOLD && !t.reviewed && t.catSource !== 'manual';
  const isTransfer = cat?.kind === 'transfer';
  return (
    <button className="row" onClick={onOpen}>
      <CatTile cat={cat} />
      <span className="row__main">
        <span className="row__title">{t.merchant}</span>
        <span className="row__sub">
          {low && <Icon name="Question" size={13} weight="fill" />} {cat?.name ?? 'Uncategorised'}{t.time ? ` · ${t.time}` : ''}{t.place ? ` · ${t.place}` : ''}{t.detail && t.detail !== t.place ? ` · ${t.detail}` : ''}
        </span>
      </span>
      <span className={`row__end row__amount${t.amount > 0 && !isTransfer ? ' row__amount--in' : ''}${isTransfer ? ' muted' : ''}`}>{fmt(t.amount, { sign: true })}</span>
    </button>
  );
}

function TxnSheet({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const { catMap, accounts, recurring } = useApp();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [pinning, setPinning] = useState(false);
  const tracked = recurring.find((r) => r.key === `out:${txn.mkey}`);
  const [learn, setLearn] = useState(true);
  const cat = catMap.get(txn.categoryId);

  const choose = async (c: Category) => {
    setPicking(false);
    const n = await setCategory(txn.id, c.id, learn);
    toast(n > 0 ? `Moved to ${c.name}, plus ${n} more from ${txn.merchant}` : `Moved to ${c.name}`);
  };

  return (
    <>
      <Sheet title="Transaction" onClose={onClose}>
        <div className="txn-hero">
          <CatTile cat={cat} size="lg" />
          <h3 className="t-h2">{txn.merchant}</h3>
          <span className="t-stat num">{fmt(txn.amount, { sign: true })}</span>
          <span className="t-small">{fmtFull(txn.date)}{txn.time ? ` · ${txn.time}` : ''}{txn.place ? ` · ${txn.place}` : ''}</span>
        </div>

        <button className="row row--hover pick-row" onClick={() => setPicking(true)}>
          <CatTile cat={cat} size="sm" />
          <span className="row__main"><span className="row__sub">Category</span><span className="row__title">{cat?.name ?? 'Uncategorised'}</span></span>
          <Icon name="CaretRight" size={18} />
        </button>
        <label className="split">
          <span className="t-small">Apply to every {txn.merchant} payment</span>
          <span className="switch"><input type="checkbox" role="switch" checked={learn} onChange={(e) => setLearn(e.target.checked)} aria-label="Apply to every payment from this merchant" /><span className="switch__track" /></span>
        </label>

        <Banner icon={txn.confidence < REVIEW_THRESHOLD ? 'Question' : 'Info'} tone={txn.confidence < REVIEW_THRESHOLD && !txn.reviewed ? 'warn' : undefined}>
          <strong>{txn.catSource === 'manual' ? 'Set by you' : txn.reason}</strong>
          {txn.catSource !== 'manual' && <div className="t-xs">Confidence {Math.round(txn.confidence * 100)}%{txn.confidence < REVIEW_THRESHOLD && !txn.reviewed ? ' · needs a look' : ''}</div>}
        </Banner>

        {txn.amount < 0 && txn.type !== 'ATM' && (
          <button className="row row--hover pick-row" onClick={() => setPinning(true)}>
            <span className="tile tile--sm"><Icon name={tracked ? 'ArrowsClockwise' : 'PushPin'} size={16} /></span>
            <span className="row__main">
              <span className="row__sub">Recurring</span>
              <span className="row__title">{tracked ? `Tracked · ${tracked.cadence}, ${fmt(tracked.amount)}` : 'Track as a recurring bill'}</span>
            </span>
            <Icon name="CaretRight" size={18} />
          </button>
        )}

        <div className="field">
          <label htmlFor="note">Note</label>
          <textarea id="note" className="textarea" defaultValue={txn.note ?? ''} placeholder="Add a note" onBlur={(e) => setNote(txn.id, e.target.value)} />
        </div>

        <dl className="facts">
          <div><dt>Account</dt><dd>{accounts.find((a) => a.id === txn.accountId)?.name ?? '—'}</dd></div>
          <div><dt>Bank code</dt><dd>{txn.type || '—'}</dd></div>
          {txn.fx && <div><dt>Foreign currency</dt><dd>{txn.fx}</dd></div>}
          <div><dt>When</dt><dd>{fmtFull(txn.date)}{txn.time ? ` at ${txn.time}` : ' · the bank prints no time for this kind of payment'}</dd></div>
          {txn.place && <div><dt>Where</dt><dd>{txn.place}<span className="muted"> · as printed by the merchant; for apps (Uber, LemFi) this is their billing city, not where you were</span></dd></div>}
          {txn.detail && txn.detail !== txn.place && <div><dt>Reference</dt><dd>{txn.detail}</dd></div>}
          <div><dt>On statement</dt><dd>{txn.raw}</dd></div>
        </dl>
      </Sheet>
      {pinning && <PinRecurringSheet mkey={txn.mkey} onClose={() => setPinning(false)} />}
      {picking && <CategorySheet current={txn.categoryId} direction={txn.amount > 0 ? 'in' : 'out'} onPick={choose} onClose={() => setPicking(false)} />}
    </>
  );
}

/**
 * Categories grouped by merchant so one decision covers many rows. By default only the uncertain ones;
 * with `all`, every merchant on the statements, so the user can decide what each one is rather than trust a guess.
 */
function ReviewQueue({ items, all }: { items: Txn[]; all?: boolean }) {
  const { catMap } = useApp();
  const toast = useToast();
  const [picker, setPicker] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const m = new Map<string, Txn[]>();
    for (const t of items) {
      const key = `${t.mkey}|${Math.sign(t.amount)}`;
      const rows = m.get(key);
      if (rows) rows.push(t);
      else m.set(key, [t]);
    }
    const needle = q.trim().toLowerCase();
    return [...m.entries()]
      .map(([key, rows]) => ({ key, rows, total: rows.reduce((s, t) => s + t.amount, 0) }))
      .filter((g) => !needle || `${g.rows[0]!.merchant} ${catMap.get(g.rows[0]!.categoryId)?.name ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [items, q, catMap]);

  if (!groups.length && !q) {
    return <section className="card"><Empty icon="CheckCircle" title={all ? 'Nothing imported yet' : 'Everything is categorised'}>{all ? 'Import a statement and every merchant on it will be listed here.' : 'Tally is confident about every transaction. New uncertain ones will show up here after your next import.'}</Empty></section>;
  }
  const active = groups.find((g) => g.key === picker);

  return (
    <>
      <Banner tone="brand" icon="Sparkle">
        {all
          ? <>Every payee on your statements, biggest first, with what Tally called it and why. Change any that are wrong: your choice becomes the rule for that payee from now on.</>
          : <>Pick a category once and Tally applies it to every payment from that merchant, now and in future imports.</>}
      </Banner>
      {all && (
        <div className="search">
          <Icon name="MagnifyingGlass" size={18} />
          <input className="input" placeholder="Find a merchant or category" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a merchant" />
        </div>
      )}
      <section className="card">
        <div className="list">
          {groups.map((g) => {
            const t = g.rows[0]!;
            const cat = catMap.get(t.categoryId);
            const unsure = t.confidence < REVIEW_THRESHOLD && !t.reviewed && t.catSource !== 'manual';
            return (
              <div key={g.key} className="review">
                <CatTile cat={cat} />
                <div className="review__main">
                  <span className="row__title">{t.merchant}</span>
                  <span className="row__sub" style={{ whiteSpace: 'normal' }}>{g.rows.length} payment{g.rows.length === 1 ? '' : 's'} · {fmt(g.total, { sign: true })} · {t.catSource === 'manual' ? 'Set by you' : t.reason}</span>
                </div>
                <div className="review__actions">
                  <button className="btn btn--secondary btn--sm" onClick={() => setPicker(g.key)}><Icon name="Tag" size={16} />{cat?.name ?? 'Choose'}</button>
                  {(unsure || !all) && <button className="btn btn--primary btn--sm" onClick={async () => { await confirmTxns(g.rows.map((r) => r.id)); toast(`Confirmed ${g.rows.length}`); }} aria-label={`Confirm ${cat?.name ?? 'category'} for ${t.merchant}`}><Icon name="Check" size={16} weight="bold" />Confirm</button>}
                </div>
              </div>
            );
          })}
          {!groups.length && <p className="t-small">No merchant matches “{q}”.</p>}
        </div>
      </section>
      {active && (
        <CategorySheet
          title={`Categorise ${active.rows[0]!.merchant}`} direction={active.total > 0 ? 'in' : 'out'} current={active.rows[0]!.categoryId} onClose={() => setPicker(null)}
          onPick={async (c) => {
            setPicker(null);
            await setCategory(active.rows[0]!.id, c.id, true);
            await setCategoryMany(active.rows.map((r) => r.id), c.id);
            toast(`${active.rows.length} moved to ${c.name}`);
          }}
        />
      )}
    </>
  );
}
