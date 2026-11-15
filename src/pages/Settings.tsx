import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useApp } from '../app/data';
import { installHelp, useInstall } from '../app/pwa';
import { addRule, deleteAccount, deleteCategory, deleteRule, recategorizeAll, renameAccount, saveCategory, wipeEverything } from '../data/actions';
import { download, exportBackup, exportCsv, restoreBackup, stamp } from '../data/backup';
import { isDemo, setDemo } from '../data/db';
import { enableBackgroundChecks, notificationSupport, requestPermission, showSystem } from '../data/notify';
import { saveSettings } from '../data/settings';
import type { Category, CategoryKind, NotificationPrefs, Settings as SettingsT } from '../domain/types';
import { uid } from '../lib/hash';
import { Banner, CardHead, CatTile, Segmented, Switch, slotColor } from '../ui/components/bits';
import { CategorySheet } from '../ui/components/CategoryPicker';
import { ProfileForm } from '../ui/components/Profile';
import { Sheet, useConfirm, useToast } from '../ui/components/overlay';
import { Icon, PICKABLE } from '../ui/icons';
import { RegionPicker, regionLine } from '../ui/components/RegionPicker';

const KINDS: Array<{ value: CategoryKind; label: string }> = [
  { value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }, { value: 'saving', label: 'Saving' },
  { value: 'debt', label: 'Debt' }, { value: 'transfer', label: 'Transfer' },
];

export function Settings() {
  const app = useApp();
  const { settings, accounts, categories, rules, catMap } = app;
  const n = settings.notifications;
  const toast = useToast();
  const ask = useConfirm();
  const install = useInstall();
  const [perm, setPerm] = useState(notificationSupport());
  const [editCat, setEditCat] = useState<Category | 'new' | null>(null);
  const [backup, setBackup] = useState<'export' | 'restore' | null>(null);
  const [newRule, setNewRule] = useState(false);

  const setN = (patch: Partial<NotificationPrefs>) => saveSettings({ notifications: { ...n, ...patch } });
  const overrides = Object.keys(n.items).length;

  const turnOn = async () => {
    const p = await requestPermission();
    setPerm(p);
    if (p === 'granted') {
      await setN({ enabled: true });
      const bg = await enableBackgroundChecks();
      await showSystem({ id: 'welcome', title: 'Notifications are on', body: bg ? 'Tally will also check in the background.' : 'You’ll get alerts while Tally is open.', route: '/' });
      toast(bg ? 'Notifications on, with background checks' : 'Notifications on');
    } else if (p === 'denied') toast('Blocked in browser settings. Allow notifications for this site, then try again.');
  };

  const toggles: Array<{ key: keyof NotificationPrefs; title: string; sub: string; icon: string }> = [
    { key: 'budget', title: 'Budget limits', sub: 'When a category reaches 80% and 100%, and unusual charges', icon: 'Gauge' },
    { key: 'bills', title: 'Bills and debts coming due', sub: 'A reminder about three days before', icon: 'CalendarBlank' },
    { key: 'missed', title: 'Missed and late payments', sub: 'When an expected payment hasn’t appeared, or keeps arriving late', icon: 'WarningCircle' },
    { key: 'debt', title: 'Debt pay-by dates', sub: 'A fortnight before a deadline you’ve set', icon: 'Scales' },
    { key: 'statements', title: 'Statement reminders', sub: 'When your imports are more than a month old', icon: 'UploadSimple' },
    { key: 'monthEnd', title: 'Month-end report card', sub: 'A nudge to add statements and get your grade when a budget month ends', icon: 'GraduationCap' },
    { key: 'weekly', title: 'Monday recap', sub: 'Last week’s spending in a sentence', icon: 'CalendarBlank' },
  ];

  return (
    <div className="bento">
      <section className="card span-12" id="profile">
        <CardHead title="About you" sub="Your pay and rent in your own words. These beat anything Tally detects." />
        <ProfileForm />
      </section>
      <section className="card span-6">
        <CardHead title="General" />
        <div className="field">
          <span className="field__label">Where you bank</span>
          <RegionPicker value={settings.region ?? 'uk'} reload />
          <span className="field__hint">{regionLine(settings.region ?? 'uk')} Changing this does not convert amounts already imported.</span>
        </div>
        <div className="field">
          <label htmlFor="startday">Month starts on day</label>
          <select id="startday" className="select" value={settings.monthStartDay} onChange={(e) => saveSettings({ monthStartDay: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i === 0 ? '1 (calendar month)' : i + 1}</option>)}
          </select>
          <span className="field__hint">Paid on the 25th? Start your budget month then, and every total follows.</span>
        </div>
        <div className="field">
          <span className="field__label">Appearance</span>
          <Segmented<SettingsT['theme']> label="Theme" value={settings.theme} onChange={(v) => saveSettings({ theme: v })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </div>
        {!install.installed && (
          <div className="field">
            <span className="field__label">Install</span>
            {install.canInstall
              ? <button className="btn btn--secondary" onClick={install.install}><Icon name="DownloadSimple" size={18} />Install Tally on this device</button>
              : <span className="field__hint">{installHelp()}</span>}
          </div>
        )}
      </section>

      <section className="card span-6">
        <CardHead title="Notifications" sub="Worked out on this device. Nothing is sent anywhere." />
        {perm === 'unsupported' && <Banner tone="warn">This browser can’t show system notifications. Alerts still appear in the bell inside Tally.</Banner>}
        {perm === 'denied' && <Banner tone="warn">Notifications are blocked for this site. Allow them in your browser’s site settings.</Banner>}
        {(perm === 'default' || (perm === 'granted' && !n.enabled)) && (
          <div className="banner banner--brand">
            <Icon name="BellRinging" size={20} /><div className="banner__body">Get alerts on your device, not only inside the app.</div>
            <button className="btn btn--primary btn--sm" onClick={turnOn}>Turn on</button>
          </div>
        )}
        {perm === 'granted' && n.enabled && (
          <div className="split">
            <span className="chip chip--good"><Icon name="CheckCircle" size={14} weight="fill" />System notifications on</span>
            <button className="btn btn--secondary btn--sm" onClick={() => showSystem({ id: `test-${Date.now()}`, title: 'Test from Tally', body: 'This is how alerts will look.', route: '/' })}>Send a test</button>
          </div>
        )}
        <div className="list">
          {toggles.map((t) => (
            <label className="row row--hover" key={t.key as string}>
              <span className="tile tile--ink"><Icon name={t.icon} size={20} /></span>
              <span className="row__main"><span className="row__title">{t.title}</span><span className="row__sub" style={{ whiteSpace: 'normal' }}>{t.sub}</span></span>
              <Switch checked={n[t.key] as boolean} label={t.title} onChange={(v) => setN({ [t.key]: v } as Partial<NotificationPrefs>)} />
            </label>
          ))}
        </div>
        {n.missed && (
          <>
            <hr className="divider" />
            <div className="form-grid form-grid--2">
              <div className="field">
                <label htmlFor="ma">Bills and subscriptions</label>
                <select id="ma" className="select" value={n.missedAfter} onChange={(e) => setN({ missedAfter: Number(e.target.value) as 1 | 2 | 3 })}>
                  <option value={1}>Alert on the first miss</option><option value={2}>After 2 missed in a row</option><option value={3}>After 3 missed in a row</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="mb">Debt repayments</label>
                <select id="mb" className="select" value={n.debtMissedAfter} onChange={(e) => setN({ debtMissedAfter: Number(e.target.value) as 1 | 2 | 3 })}>
                  <option value={1}>Alert on the first miss</option><option value={2}>After 2 missed in a row</option><option value={3}>After 3 missed in a row</option>
                </select>
              </div>
            </div>
            <p className="t-xs">
              Set a different rule for any single payment with the bell on the Recurring or Debts pages.
              {overrides > 0 && <> You have {overrides} custom rule{overrides === 1 ? '' : 's'}. <button className="link" onClick={() => setN({ items: {} })}>Reset</button></>}
            </p>
          </>
        )}
        <p className="t-xs">Background alerts while the app is closed need an installed Chrome or Edge app; on iPhone and in Firefox, alerts appear when you open Tally.</p>
      </section>

      <section className="card span-6">
        <CardHead title="Accounts" />
        {accounts.length === 0 ? <p className="t-small">Accounts appear when you import a statement.</p> : (
          <div className="list">
            {accounts.map((a) => (
              <div className="row" key={a.id}>
                <span className="tile tile--ink"><Icon name="Bank" size={20} /></span>
                <span className="row__main">
                  <input className="input input--inline" defaultValue={a.name} aria-label={`Name of ${a.name}`} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== a.name) void renameAccount(a.id, e.target.value); }} />
                  <span className="row__sub">{a.bank}{a.holder ? ` · ${a.holder}` : ''}</span>
                </span>
                <button className="icon-btn" aria-label={`Delete ${a.name}`} onClick={async () => { if (await ask({ title: `Delete ${a.name}?`, body: 'Its transactions and imported statements will be removed from Tally.', confirmLabel: 'Delete', danger: true })) { await deleteAccount(a.id); toast('Account deleted'); } }}><Icon name="Trash" size={18} /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card span-6">
        <CardHead title="Rules" sub="How Tally decides categories. Yours always win." action={<button className="btn btn--secondary btn--sm" onClick={() => setNewRule(true)}><Icon name="Plus" size={16} weight="bold" />Add</button>} />
        {rules.length === 0 ? <p className="t-small">No rules yet. Change a transaction’s category and Tally learns it automatically.</p> : (
          <div className="list">
            {[...rules].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((r) => (
              <div className="row" key={r.id}>
                <CatTile cat={catMap.get(r.categoryId)} size="sm" />
                <span className="row__main">
                  <span className="row__title">{r.match === 'merchant' ? r.pattern : `“${r.pattern}”`}</span>
                  <span className="row__sub">{r.kind === 'learned' ? 'Learned' : r.debtId ? 'From a debt' : 'Your rule'} → {catMap.get(r.categoryId)?.name}{r.dir ? ` (${r.dir === 'out' ? 'money out' : 'money in'})` : ''}</span>
                </span>
                <button className="icon-btn" aria-label={`Delete rule ${r.pattern}`} onClick={() => deleteRule(r.id)}><Icon name="X" size={18} /></button>
              </div>
            ))}
          </div>
        )}
        <button className="btn btn--ghost btn--sm" onClick={async () => toast(`Re-checked: ${await recategorizeAll()} changed`)}><Icon name="ArrowCounterClockwise" size={16} />Re-apply to all transactions</button>
      </section>

      <section className="card span-12">
        <CardHead title="Categories" action={<button className="btn btn--secondary btn--sm" onClick={() => setEditCat('new')}><Icon name="Plus" size={16} weight="bold" />Add</button>} />
        <div className="cat-grid">
          {categories.map((c) => (
            <button key={c.id} className="cat-chip" onClick={() => setEditCat(c)}>
              <CatTile cat={c} size="sm" /><span>{c.name}</span>
              {c.slot !== null && <i className="cat-chip__dot" style={{ background: slotColor(c.slot) }} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </section>

      <section className="card span-12">
        <CardHead title="Your data" sub="Stored only in this browser. Back it up so a cleared browser doesn’t lose it." />
        <div className="cluster">
          <button className="btn btn--secondary" onClick={() => setBackup('export')}><Icon name="LockKey" size={18} />Encrypted backup</button>
          <button className="btn btn--secondary" onClick={() => setBackup('restore')}><Icon name="UploadSimple" size={18} />Restore backup</button>
          <button className="btn btn--secondary" onClick={async () => download(await exportCsv(), `tally-transactions-${stamp()}.csv`)}><Icon name="FileCsv" size={18} />Export CSV</button>
          {isDemo
            ? <button className="btn btn--ghost" onClick={() => setDemo(false)}>Exit demo</button>
            : <button className="btn btn--ghost" onClick={() => setDemo(true)}><Icon name="Sparkle" size={18} />Explore sample data</button>}
          <button className="btn btn--danger" onClick={async () => { if (await ask({ title: 'Erase everything?', body: 'All statements, transactions, budgets and debts in this browser will be deleted. This cannot be undone. Make a backup first if unsure.', confirmLabel: 'Erase all data', danger: true })) await wipeEverything(); }}>Erase all data</button>
        </div>
      </section>

      {editCat && <CategoryEditor cat={editCat === 'new' ? null : editCat} onClose={() => setEditCat(null)} />}
      {backup && <BackupSheet mode={backup} onClose={() => setBackup(null)} />}
      {newRule && <RuleEditor onClose={() => setNewRule(false)} />}
    </div>
  );
}

function CategoryEditor({ cat, onClose }: { cat: Category | null; onClose: () => void }) {
  const { categories } = useApp();
  const ask = useConfirm();
  const [name, setName] = useState(cat?.name ?? '');
  const [icon, setIcon] = useState(cat?.icon ?? 'Tag');
  const [kind, setKind] = useState<CategoryKind>(cat?.kind ?? 'expense');
  const [slot, setSlot] = useState<number | null>(cat?.slot ?? null);
  const [fixed, setFixed] = useState(cat?.fixed ?? false);

  const save = async () => {
    if (!name.trim()) return;
    await saveCategory({ id: cat?.id ?? `c-${uid()}`, name: name.trim(), icon, kind, slot, fixed, order: cat?.order ?? categories.length + 1, system: cat?.system });
    onClose();
  };
  return (
    <Sheet
      title={cat ? 'Edit category' : 'New category'} onClose={onClose}
      footer={<>
        {cat && !cat.system && <button className="btn btn--danger" onClick={async () => { if (await ask({ title: `Delete ${cat.name}?`, body: 'Its transactions move to “Uncategorised”.', confirmLabel: 'Delete', danger: true })) { await deleteCategory(cat.id); onClose(); } }}>Delete</button>}
        <span className="grow" />
        <button className="btn btn--primary" onClick={save} disabled={!name.trim()}>Save</button>
      </>}
    >
      <div className="field"><label htmlFor="cname">Name</label><input id="cname" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><span className="field__label">Icon</span>
        <div className="icon-grid" role="radiogroup" aria-label="Icon">
          {PICKABLE.map((i) => <button key={i} role="radio" aria-checked={icon === i} aria-label={i} className="icon-grid__btn" onClick={() => setIcon(i)}><Icon name={i} size={22} /></button>)}
        </div>
      </div>
      <div className="form-grid form-grid--2">
        <div className="field"><label htmlFor="ckind">Type</label><select id="ckind" className="select" value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)} disabled={!!cat?.system}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></div>
        <div className="field"><span className="field__label">Chart colour</span>
          <div className="swatches" role="radiogroup" aria-label="Chart colour">
            <button role="radio" aria-checked={slot === null} className="swatch swatch--none" onClick={() => setSlot(null)} aria-label="No colour" title="Neutral">{slot === null && <Icon name="Check" size={14} weight="bold" />}</button>
            {Array.from({ length: 8 }, (_, i) => (
              <button key={i} role="radio" aria-checked={slot === i} aria-label={`Colour ${i + 1}`} className="swatch" style={{ '--sw': slotColor(i) } as CSSProperties} onClick={() => setSlot(i)}>{slot === i && <Icon name="Check" size={14} weight="bold" />}</button>
            ))}
          </div>
        </div>
      </div>
      {kind === 'expense' && (
        <label className="split"><span><span className="t-label" style={{ color: 'var(--ink)' }}>Fixed bill</span><span className="field__hint" style={{ display: 'block' }}>Assumed paid in full each cycle, not paced daily.</span></span><Switch checked={fixed} onChange={setFixed} label="Fixed bill" /></label>
      )}
    </Sheet>
  );
}

function RuleEditor({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [pick, setPick] = useState(false);
  const [cat, setCat] = useState<Category | null>(null);
  return (
    <>
      <Sheet title="New rule" onClose={onClose} footer={<button className="btn btn--primary" disabled={!text.trim() || !cat} onClick={async () => { await addRule({ kind: 'user', match: 'contains', pattern: text.trim(), categoryId: cat!.id }); await recategorizeAll(); toast('Rule saved and applied'); onClose(); }}>Save rule</button>}>
        <div className="field"><label htmlFor="rtext">When a transaction contains</label><input id="rtext" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. tesco" /><span className="field__hint">Matches the merchant name and the statement text, ignoring capitals.</span></div>
        <button className="row row--hover pick-row" onClick={() => setPick(true)}>
          {cat ? <CatTile cat={cat} size="sm" /> : <span className="tile tile--sm tile--ink"><Icon name="Tag" size={16} /></span>}
          <span className="row__main"><span className="row__sub">Put it in</span><span className="row__title">{cat?.name ?? 'Choose a category'}</span></span>
          <Icon name="CaretRight" size={18} />
        </button>
      </Sheet>
      {pick && <CategorySheet onPick={(c) => { setCat(c); setPick(false); }} onClose={() => setPick(false)} />}
    </>
  );
}

function BackupSheet({ mode, onClose }: { mode: 'export' | 'restore'; onClose: () => void }) {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const run = async () => {
    setErr('');
    setBusy(true);
    try {
      if (mode === 'export') {
        if (pass.length < 8) throw new Error('Use at least 8 characters.');
        if (pass !== again) throw new Error('The passphrases don’t match.');
        download(await exportBackup(pass), `tally-backup-${stamp()}.tally`);
        await saveSettings({ lastBackupAt: Date.now() });
        toast('Backup saved. Keep the passphrase safe; it can’t be recovered.');
      } else {
        const f = file.current?.files?.[0];
        if (!f) throw new Error('Choose a backup file.');
        await restoreBackup(await f.text(), pass);
        toast('Backup restored');
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={mode === 'export' ? 'Encrypted backup' : 'Restore a backup'} onClose={onClose} footer={<button className="btn btn--primary" onClick={run} disabled={busy}>{busy ? 'Working…' : mode === 'export' ? 'Save backup' : 'Restore'}</button>}>
      <Banner tone="brand" icon="LockKey">
        {mode === 'export' ? 'Your data is encrypted here, on this device, with your passphrase before it’s saved. Without the passphrase the file is unreadable, to everyone, including us.' : 'Restoring replaces everything currently in Tally with the contents of the backup.'}
      </Banner>
      {mode === 'restore' && <div className="field"><label htmlFor="bfile">Backup file</label><input id="bfile" ref={file} className="input" type="file" accept=".tally,application/json" /></div>}
      <div className="field"><label htmlFor="bpass">Passphrase</label><input id="bpass" className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} /></div>
      {mode === 'export' && <div className="field"><label htmlFor="bagain">Repeat passphrase</label><input id="bagain" className="input" type="password" autoComplete="off" value={again} onChange={(e) => setAgain(e.target.value)} /></div>}
      {err && <Banner tone="critical">{err}</Banner>}
    </Sheet>
  );
}
