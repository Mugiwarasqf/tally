import { useCallback, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useApp } from '../app/data';
import { db } from '../data/db';
import { commitImport, removeImport } from '../data/importer';
import { accountKey } from '../domain/import/build';
import { ACCEPTED, readStatementFile } from '../domain/import/detect';
import { parseCsvRows } from '../domain/import/csv';
import type { CsvAnalysis, CsvMapping, DateOrder } from '../domain/import/csv';
import { layoutFrom, readPdfWith, ROLE_LABEL } from '../domain/import/generic';
import type { MoneyRole, PdfAnalysis } from '../domain/import/generic';
import { loadPdfLayouts, savePdfLayout } from '../data/pdfLayouts';
import { ImportError } from '../domain/import/types';
import type { ParsedStatement } from '../domain/import/types';
import { addDays, diffDays, fmtDay, fmtDayYear } from '../lib/dates';
import { sha256Hex, uid } from '../lib/hash';
import { fmt } from '../lib/money';
import { Banner, CardHead, Empty, IconTile } from '../ui/components/bits';
import { Sheet, useToast } from '../ui/components/overlay';
import { Icon } from '../ui/icons';

interface Candidate {
  id: string;
  file: File;
  hash: string;
  state: 'reading' | 'ready' | 'needs-mapping' | 'error' | 'duplicate' | 'done';
  parsed?: ParsedStatement;
  csv?: CsvAnalysis;
  pdf?: PdfAnalysis;
  error?: string;
  duplicateOf?: string;
  account: string; // existing account id or 'new'
  accountName: string;
  result?: { added: number; skipped: number };
}

const size = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function Import() {
  const { accounts, files, coverage, today } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<Candidate[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const patch = useCallback((id: string, p: Partial<Candidate>) => setItems((s) => s.map((c) => (c.id === id ? { ...c, ...p } : c))), []);

  const read = useCallback(async (list: File[]) => {
    const fresh: Candidate[] = list.map((file) => ({ id: uid(), file, hash: '', state: 'reading', account: 'new', accountName: '' }));
    setItems((s) => [...s, ...fresh]);
    const layouts = await loadPdfLayouts().catch(() => []);
    for (const c of fresh) {
      try {
        const bytes = await c.file.arrayBuffer();
        const hash = await sha256Hex(bytes);
        const dup = await db.files.where('hash').equals(hash).first();
        if (dup) { patch(c.id, { hash, state: 'duplicate', duplicateOf: dup.name }); continue; }
        const r = await readStatementFile(c.file, bytes, layouts);
        const accts = await db.accounts.toArray();
        let account = 'new';
        if (r.parsed) {
          const key = accountKey(r.parsed);
          account = accts.find((a) => a.key === key)?.id ?? (!r.parsed.format.startsWith('pdf') && accts.length === 1 ? accts[0]!.id : 'new');
        }
        patch(c.id, {
          hash, parsed: r.parsed ?? undefined, csv: r.csv, pdf: r.pdf, account,
          accountName: r.parsed ? (r.parsed.account.number ? `${r.parsed.bank} ····${r.parsed.account.number.slice(-4)}` : r.parsed.account.label ?? c.file.name.replace(/\.[^.]+$/, '')) : c.file.name.replace(/\.[^.]+$/, ''),
          state: r.parsed ? 'ready' : 'needs-mapping',
        });
      } catch (e) {
        // Say why: a bare "could not be read" hid a browser incompatibility once.
        const why = e instanceof Error && e.message ? ` (${e.name}: ${e.message.slice(0, 160)})` : '';
        patch(c.id, { state: 'error', error: e instanceof ImportError ? e.message : `This file could not be read${why}. Try reloading the page; if it keeps happening, a CSV from your bank will work.` });
      }
    }
  }, [patch]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void read([...e.dataTransfer.files]);
  };

  const ready = items.filter((c) => c.state === 'ready' && c.parsed);
  const importAll = async () => {
    setBusy(true);
    let added = 0;
    let skipped = 0;
    for (const c of ready) {
      try {
        const r = await commitImport({ parsed: c.parsed!, fileName: c.file.name, hash: c.hash, choice: c.account === 'new' ? { name: c.accountName } : { id: c.account } });
        patch(c.id, { state: 'done', result: { added: r.added, skipped: r.skipped } });
        added += r.added;
        skipped += r.skipped;
      } catch {
        patch(c.id, { state: 'error', error: 'Saving failed. Try again.' });
      }
    }
    setBusy(false);
    toast(`Added ${added.toLocaleString('en-GB')} transaction${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already on file` : ''}`);
  };

  // coverage timeline ------------------------------------------------------------
  const spans = coverage.filter((c) => c.spans.length);
  const tStart = spans.length ? spans.map((c) => c.first!).sort()[0]! : today;
  const lastCov = spans.length ? spans.map((c) => c.last!).sort().at(-1)! : today;
  const tEnd = lastCov > today ? lastCov : today;
  const total = Math.max(1, diffDays(tStart, tEnd) + 1);
  const pct = (d: string) => `${(Math.max(0, diffDays(tStart, d)) / total) * 100}%`;
  const wid = (a: string, b: string) => `${((diffDays(a, b) + 1) / total) * 100}%`;
  const months = useMemo(() => {
    const out: string[] = [];
    for (let d = `${tStart.slice(0, 7)}-01`; d <= tEnd; d = addDays(d, 32).slice(0, 7) + '-01') out.push(d);
    return out;
  }, [tStart, tEnd]);

  return (
    <>
      <div
        className="dropzone" data-over={over} role="button" tabIndex={0}
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
      >
        <IconTile name="UploadSimple" tone="brand" size="lg" />
        <h2 className="t-title">Drop statements here</h2>
        <p className="t-small">PDF statements from any bank, or CSV, OFX and QIF files. Add as many months as you like. Files are read on this device and never uploaded.</p>
        <span className="btn btn--primary">Choose files</span>
        <input ref={input} type="file" multiple accept={ACCEPTED} onChange={(e) => { void read([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>

      {items.length > 0 && (
        <section className="stack">
          {items.map((c) => (
            <CandidateCard key={c.id} c={c} accounts={accounts} patch={patch} onRemove={() => setItems((s) => s.filter((x) => x.id !== c.id))} />
          ))}
          {ready.length > 0 && (
            <div className="sticky-action">
              <button className="btn btn--primary btn--block" onClick={importAll} disabled={busy}>
                {busy ? 'Importing…' : `Import ${ready.length} statement${ready.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          {items.every((c) => c.state === 'done') && (
            <Banner tone="good" icon="CheckCircle" action={<span className="cluster"><a className="btn btn--primary btn--sm" href="#/">Set up pay and rent</a><a className="btn btn--secondary btn--sm" href="#/transactions?by=merchant">Check categories</a></span>}>
              <strong>All imported.</strong> Next: tell Tally your pay and rent, then check each merchant’s category. Nothing is assumed.
            </Banner>
          )}
        </section>
      )}

      <section className="card">
        <CardHead title="Statement coverage" sub="Which dates your imported statements cover. Gaps make budgets and balances less accurate." />
        {spans.length === 0 ? (
          <Empty icon="CalendarBlank" title="No statements yet">Once you import one, you’ll see exactly which dates it covers.</Empty>
        ) : (
          <div className="cover">
            {coverage.filter((c) => c.spans.length).map((c) => (
              <div key={c.account.id} className="cover__row">
                <span className="t-label">{c.account.name}</span>
                <div className="cover__track" role="img" aria-label={`${c.account.name} covered ${c.spans.map((s) => `${fmtDay(s.start)} to ${fmtDay(s.end)}`).join(', ')}`}>
                  {c.spans.map((s) => <i key={s.start} className="cover__have" style={{ left: pct(s.start), width: wid(s.start, s.end) }} />)}
                  {c.gaps.map((g) => <i key={g.start} className="cover__gap" style={{ left: pct(g.start), width: wid(g.start, g.end) }} title={`Missing ${fmtDay(g.start)} – ${fmtDay(g.end)}`} />)}
                  {c.last && c.last < tEnd && <i className="cover__gap" style={{ left: pct(addDays(c.last, 1)), width: wid(addDays(c.last, 1), tEnd) }} title={`Nothing after ${fmtDay(c.last)}`} />}
                </div>
                <div className="cover__months" aria-hidden="true">
                  {months.map((m) => <span key={m} style={{ left: pct(m < tStart ? tStart : m) }}>{new Date(m).toLocaleString('en-GB', { month: 'short' })}</span>)}
                </div>
                {(c.gaps.length > 0 || (c.last && c.last < addDays(today, -7))) && (
                  <p className="t-xs">
                    {c.gaps.map((g) => `Missing ${fmtDay(g.start)} – ${fmtDay(g.end)}`).join(' · ')}
                    {c.last && c.last < addDays(today, -7) ? `${c.gaps.length ? ' · ' : ''}Nothing after ${fmtDay(c.last)}` : ''}
                  </p>
                )}
              </div>
            ))}
            <div className="legend">
              <span className="legend__item"><i className="legend__sw" style={{ background: 'var(--bar)' }} />Covered</span>
              <span className="legend__item"><i className="legend__sw cover__gap-sw" />Not covered</span>
            </div>
          </div>
        )}
      </section>

      {files.length > 0 && (
        <section className="card">
          <CardHead title="Imported statements" sub={`${files.length} file${files.length === 1 ? '' : 's'}`} />
          <div className="list">
            {[...files].sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? '')).map((f) => (
              <div key={f.id} className="row">
                <IconTile name={f.format.startsWith('pdf') ? 'FilePdf' : f.format === 'csv' ? 'FileCsv' : 'FileIcon'} tone="ink" />
                <span className="row__main">
                  <span className="row__title">{f.name}</span>
                  <span className="row__sub">{f.periodStart ? `${fmtDayYear(f.periodStart)} – ${f.periodEnd ? fmtDayYear(f.periodEnd) : ''}` : 'No period'} · {f.addedCount} added{f.txnCount !== f.addedCount ? ` of ${f.txnCount}` : ''}</span>
                </span>
                <span className="row__end cluster" style={{ justifyContent: 'flex-end' }}>
                  {f.reconciled === true && <span className="chip chip--good"><Icon name="CheckCircle" size={14} weight="fill" />Reconciled</span>}
                  {f.reconciled === false && <span className="chip chip--warn"><Icon name="Warning" size={14} weight="fill" />Check totals</span>}
                  <button className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setConfirmDelete(f.id)}><Icon name="Trash" size={18} /></button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {confirmDelete && (
        <Sheet
          title="Remove this statement?" onClose={() => setConfirmDelete(null)}
          footer={<><button className="btn btn--ghost" onClick={() => setConfirmDelete(null)}>Cancel</button><button className="btn btn--danger" onClick={async () => { await removeImport(confirmDelete); setConfirmDelete(null); toast('Statement removed'); }}>Remove</button></>}
        >
          <p className="t-small">The transactions it brought in will be deleted. You can import the file again any time.</p>
        </Sheet>
      )}
    </>
  );
}

function CandidateCard({ c, accounts, patch, onRemove }: { c: Candidate; accounts: Array<{ id: string; name: string }>; patch: (id: string, p: Partial<Candidate>) => void; onRemove: () => void }) {
  const p = c.parsed;
  const icon = /\.pdf$/i.test(c.file.name) ? 'FilePdf' : /\.csv$/i.test(c.file.name) ? 'FileCsv' : 'FileIcon';
  return (
    <article className="card cand">
      <div className="split" style={{ alignItems: 'flex-start' }}>
        <div className="cluster" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
          <IconTile name={icon} tone="ink" />
          <div style={{ minWidth: 0 }}>
            <div className="row__title">{c.file.name}</div>
            <div className="t-xs">{size(c.file.size)}{p ? ` · ${p.bank}` : ''}</div>
          </div>
        </div>
        {c.state !== 'done' && <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${c.file.name} from the list`}><Icon name="X" size={18} /></button>}
      </div>

      {c.state === 'reading' && <p className="t-small"><Icon name="Clock" size={16} /> Reading…</p>}
      {c.state === 'duplicate' && <Banner tone="warn" icon="Info">Already imported as <strong>{c.duplicateOf}</strong>. Nothing to do.</Banner>}
      {c.state === 'error' && <Banner tone="critical" icon="WarningCircle">{c.error}</Banner>}
      {c.state === 'done' && <Banner tone="good" icon="CheckCircle">Added <strong>{c.result!.added}</strong>{c.result!.skipped ? `, skipped ${c.result!.skipped} you already had` : ''}.</Banner>}

      {c.state === 'needs-mapping' && c.csv && (
        <CsvMapper csv={c.csv} fileName={c.file.name} onParsed={(parsed) => patch(c.id, { parsed, state: 'ready' })} />
      )}
      {c.state === 'needs-mapping' && c.pdf && (
        <PdfMapper key={c.pdf.roles.join()} pdf={c.pdf} onParsed={(parsed, pdf) => patch(c.id, { parsed, pdf, state: 'ready', accountName: parsed.account.number ? `${parsed.bank} ····${parsed.account.number.slice(-4)}` : pdf.bank || c.accountName })} />
      )}

      {c.state === 'ready' && p && (
        <>
          <div className="stats stats--4">
            <div className="stat"><span className="stat__label">Transactions</span><span className="stat__value">{p.txns.length}</span></div>
            <div className="stat"><span className="stat__label">Period</span><span className="t-label" style={{ color: 'var(--ink)' }}>{p.periodStart && p.periodEnd ? `${fmtDay(p.periodStart)} – ${fmtDay(p.periodEnd)}` : '—'}</span></div>
            <div className="stat"><span className="stat__label">Money in</span><span className="stat__value">{fmt(p.txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0), { whole: true })}</span></div>
            <div className="stat"><span className="stat__label">Money out</span><span className="stat__value">{fmt(-p.txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0), { whole: true })}</span></div>
          </div>
          {p.checks.length > 0 && (
            <ul className="checks">
              {p.checks.map((k) => (
                <li key={k.name} className={k.ok ? 'is-ok' : 'is-bad'}>
                  <Icon name={k.ok ? 'CheckCircle' : 'WarningCircle'} size={18} weight="fill" />
                  <span><strong>{k.name}.</strong> {k.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {p.warnings.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
          {p.format === 'pdf-generic' && c.pdf && (
            <p className="t-small split">
              <span>{c.pdf.fromSaved ? 'Read with the layout you confirmed before.' : 'Columns worked out from the statement and proved by its balance.'}</span>
              <button className="btn btn--ghost btn--sm" onClick={() => patch(c.id, { state: 'needs-mapping' })}><Icon name="Sliders" size={16} />Adjust columns</button>
            </p>
          )}
          <div className="form-grid form-grid--2">
            <div className="field">
              <label htmlFor={`acct-${c.id}`}>Account</label>
              <select id={`acct-${c.id}`} className="select" value={c.account} onChange={(e) => patch(c.id, { account: e.target.value })}>
                <option value="new">New account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            {c.account === 'new' && (
              <div className="field">
                <label htmlFor={`name-${c.id}`}>Account name</label>
                <input id={`name-${c.id}`} className="input" value={c.accountName} onChange={(e) => patch(c.id, { accountName: e.target.value })} />
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}

/**
 * A PDF from a bank Tally has no dedicated reader for, whose columns the balance couldn't prove.
 * The user names each money column; the preview and the balance check update as they choose.
 */
function PdfMapper({ pdf, onParsed }: { pdf: PdfAnalysis; onParsed: (p: ParsedStatement, pdf: PdfAnalysis) => void }) {
  const [roles, setRoles] = useState<MoneyRole[]>(pdf.roles);
  const [order, setOrder] = useState<DateOrder>(pdf.dateOrder);
  const [remember, setRemember] = useState(true);
  const reading = useMemo(() => readPdfWith(pdf, roles, order), [pdf, roles, order]);
  const p = reading.parsed;
  const remembers = pdf.bank ? `Remember this layout for ${pdf.bank} statements` : 'Remember this layout for statements like this one';
  const apply = async () => {
    if (remember) await savePdfLayout(layoutFrom(pdf, roles, order, Date.now())).catch(() => undefined);
    onParsed(p, { ...pdf, roles, dateOrder: order, result: reading });
  };
  return (
    <>
      <Banner tone={reading.verified ? 'good' : 'brand'} icon={reading.verified ? 'CheckCircle' : 'Sliders'}>
        {reading.verified
          ? <><strong>These columns add up.</strong> Every printed balance agrees with this reading.</>
          : <><strong>Which column is which?</strong> {reading.reason} Name each money column; the preview and checks below update as you go.</>}
      </Banner>
      <div className="form-grid form-grid--2">
        {pdf.columns.map((col, i) => (
          <div className="field" key={col.edge}>
            <label htmlFor={`pdfcol-${i}`}>{col.label ? `“${col.label}”` : `Money column ${i + 1}`}</label>
            <select id={`pdfcol-${i}`} className="select" value={roles[i]} onChange={(e) => setRoles(roles.map((r, j) => (j === i ? (e.target.value as MoneyRole) : r)))}>
              {(Object.keys(ROLE_LABEL) as MoneyRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <span className="field__hint">e.g. {col.samples.join(', ') || '—'}</span>
          </div>
        ))}
        <div className="field">
          <label htmlFor="pdf-dates">Date format</label>
          <select id="pdf-dates" className="select" value={order} onChange={(e) => setOrder(e.target.value as DateOrder)}>
            <option value="dmy">Day / month / year</option><option value="mdy">Month / day / year</option><option value="ymd">Year-month-day</option>
          </select>
        </div>
      </div>
      {p.checks.length > 0 && (
        <ul className="checks">
          {p.checks.map((k) => (
            <li key={k.name} className={k.ok ? 'is-ok' : 'is-bad'}>
              <Icon name={k.ok ? 'CheckCircle' : 'WarningCircle'} size={18} weight="fill" />
              <span><strong>{k.name}.</strong> {k.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {p.warnings.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
      {p.txns.length > 0 && (
        <div className="tablewrap">
          <table className="table">
            <caption className="t-xs" style={{ textAlign: 'left' }}>First {Math.min(6, p.txns.length)} of {p.txns.length} transactions as read</caption>
            <thead><tr><th>Date</th><th>Description</th><th className="r">Amount</th><th className="r">Balance</th></tr></thead>
            <tbody>
              {p.txns.slice(0, 6).map((t, i) => (
                <tr key={i}>
                  <td className="num">{fmtDay(t.date)}</td>
                  <td>{t.lines.join(' · ')}</td>
                  <td className="r">{fmt(t.amount, { sign: true })}</td>
                  <td className="r">{t.balance !== undefined ? fmt(t.balance) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <label className="split">
        <span className="t-small">{remembers}</span>
        <span className="switch"><input type="checkbox" role="switch" checked={remember} onChange={(e) => setRemember(e.target.checked)} aria-label={remembers} /><span className="switch__track" /></span>
      </label>
      <button className="btn btn--primary" onClick={() => void apply()} disabled={!p.txns.length}>Use these columns</button>
    </>
  );
}

/** When a CSV's columns can't be guessed, or the guess is wrong: choose them by hand. */
function CsvMapper({ csv, fileName, onParsed }: { csv: CsvAnalysis; fileName: string; onParsed: (p: ParsedStatement) => void }) {
  const [m, setM] = useState<CsvMapping>(csv.mapping);
  const [err, setErr] = useState<string | null>(null);
  const headers = csv.rows[m.headerRow] ?? [];
  const opts = (none = true) => (
    <>
      {none && <option value={-1}>None</option>}
      {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
    </>
  );
  const num = (v: string) => Number(v);
  const apply = () => {
    try { onParsed(parseCsvRows(csv.rows, m, fileName.replace(/\.[^.]+$/, ''))); setErr(null); }
    catch (e) { setErr(e instanceof ImportError ? e.message : 'Could not read the file with that mapping.'); }
  };
  return (
    <>
      <Banner tone="brand" icon="Sliders">Tell Tally which column is which. It remembers nothing; it only reads what you choose.</Banner>
      <div className="form-grid form-grid--2">
        <div className="field"><label>Date</label><select className="select" value={m.date} onChange={(e) => setM({ ...m, date: num(e.target.value) })}>{opts(false)}</select></div>
        <div className="field"><label>Date format</label>
          <select className="select" value={m.dateOrder} onChange={(e) => setM({ ...m, dateOrder: e.target.value as DateOrder })}>
            <option value="dmy">Day / month / year</option><option value="mdy">Month / day / year</option><option value="ymd">Year-month-day</option>
          </select></div>
        <div className="field"><label>Description</label><select className="select" value={m.description[0] ?? -1} onChange={(e) => setM({ ...m, description: num(e.target.value) >= 0 ? [num(e.target.value)] : [] })}>{opts()}</select></div>
        <div className="field"><label>Amount (one signed column)</label><select className="select" value={m.amount} onChange={(e) => setM({ ...m, amount: num(e.target.value) })}>{opts()}</select></div>
        <div className="field"><label>Money out (if separate)</label><select className="select" value={m.debit} onChange={(e) => setM({ ...m, debit: num(e.target.value) })}>{opts()}</select></div>
        <div className="field"><label>Money in (if separate)</label><select className="select" value={m.credit} onChange={(e) => setM({ ...m, credit: num(e.target.value) })}>{opts()}</select></div>
      </div>
      {err && <Banner tone="critical">{err}</Banner>}
      <button className="btn btn--primary" onClick={apply}>Use these columns</button>
    </>
  );
}
