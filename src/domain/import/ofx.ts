import { makeDate } from '../../lib/dates';
import { ImportError } from './types';
import type { ParsedStatement, RawTxn } from './types';

const tag = (block: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m?.[1]?.trim() || undefined;
};
const ofxDate = (s?: string) => (s && /^\d{8}/.test(s) ? makeDate(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8))) : undefined);
const pence = (s?: string) => (s === undefined ? undefined : Math.round(parseFloat(s.replace(/,/g, '')) * 100));

/** OFX/QFX (SGML or XML flavour): the statement format most UK banks offer besides CSV. */
export function parseOfx(text: string): ParsedStatement {
  if (!/<OFX>/i.test(text) && !/<STMTTRN>/i.test(text)) throw new ImportError('This does not look like an OFX file.');
  const txns: RawTxn[] = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const b = m[1]!;
    const date = ofxDate(tag(b, 'DTPOSTED'));
    const amount = pence(tag(b, 'TRNAMT'));
    if (!date || amount === undefined || Number.isNaN(amount) || amount === 0) continue;
    const lines = [...new Set([tag(b, 'NAME'), tag(b, 'MEMO')].filter((x): x is string => !!x))];
    txns.push({ date, amount, type: tag(b, 'TRNTYPE') ?? '', lines: lines.length ? lines : ['(no description)'] });
  }
  if (!txns.length) throw new ImportError('No transactions found in that OFX file.');
  const acct = tag(text, 'ACCTID');
  return {
    bank: tag(text, 'ORG') ?? 'OFX',
    format: 'ofx',
    account: { number: acct, sortCode: tag(text, 'BANKID'), label: [tag(text, 'BANKID'), acct].filter(Boolean).join(' ') || 'OFX account' },
    periodStart: ofxDate(tag(text, 'DTSTART')) ?? txns.map((t) => t.date).sort()[0],
    periodEnd: ofxDate(tag(text, 'DTEND')) ?? txns.map((t) => t.date).sort().at(-1),
    closing: pence(tag(text.slice(text.search(/<LEDGERBAL>/i) >= 0 ? text.search(/<LEDGERBAL>/i) : 0), 'BALAMT')),
    txns, checks: [], warnings: [],
  };
}
