/**
 * Nigerian bank narrations, turned into the payment-type codes and clean description lines the rest of the
 * categoriser already understands (BP/CR for transfers, VIS for card, FEE, POT, ATM).
 *
 * Patterns are the banks' and wallets' own wording (NIP transfers, COMM/VAT charges, "Transfer to X | Bank |
 * account"), never any person's or shop's name: people and local shops are learned from each user's choices.
 * Only used when the region is Nigeria, so UK and US statements are read exactly as before.
 */
export interface Narration {
  type: string;
  lines: string[];
}

const NETWORKS: Array<[RegExp, string]> = [[/\bMTN\b/, 'MTN'], [/\bAIRTEL\b/, 'Airtel'], [/\bGLO\b|GLOBACOM/, 'Glo'], [/\b9MOBILE\b|ETISALAT/, '9mobile']];

/** Bank charges, in the order they are checked. Each becomes its own clearly named, learnable merchant. */
const CHARGES: Array<[RegExp, string]> = [
  [/^VAT\b|\bVAT ON\b|\bVAT\s*-|^V\.?A\.?T\b/, 'VAT on bank charge'],
  [/^COMM\b|\bCOMMISSION\b|\bNIP CHARGE|\bTRANSFER FEE\b|\bTRANSFER CHARGE|\bNIBSS (?:FEE|CHARGE)/, 'Transfer charge'],
  [/STAMP DUTY/, 'Stamp duty'],
  [/ELECTRONIC MONEY TRANSFER LEVY|\bEMTL\b|\bTRANSFER LEVY/, 'Transfer levy (EMTL)'],
  [/SMS ALERT|SMS CHARGE|SMS NOTIFICATION/, 'SMS alert charges'],
  [/CARD MAINTENANCE|CARD MAINT|CARD ISSUANCE|CARD REPLACEMENT/, 'Card fee'],
  [/ACCOUNT MAINTENANCE|\bCOT\b|MAINTENANCE FEE|MAINTENANCE CHARGE/, 'Account maintenance fee'],
  [/\bTOKEN (?:FEE|CHARGE)|\bCHEQUE BOOK|STATEMENT (?:FEE|CHARGE)/, 'Bank service charge'],
];

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s|:,-]+|[\s|:,-]+$/g, '').trim();
const titled = (s: string) => clean(s).toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

export function readNarration(rawLines: string[], amount: number): Narration | null {
  const text = clean(rawLines.join(' '));
  const H = text.toUpperCase();
  const out = amount < 0;
  if (!H) return null;

  // Interest and the tax withheld from it.
  if (/\bW\.?TAX\b|WITHHOLDING TAX|\bW\/TAX\b|\bWHT\b/.test(H)) return { type: 'TAX', lines: ['Withholding tax on interest', text] };
  if (!out && (/\bINT\.?\s?PD\b|INTEREST (?:EARNED|PAID|CREDIT|PAYMENT)|CREDIT INTEREST|OWEALTH INTEREST/.test(H))) return { type: 'INT', lines: ['Interest', text] };

  // Bank charges (money out only: a credit mentioning VAT is not a charge).
  if (out) for (const [re, label] of CHARGES) if (re.test(H)) return { type: 'FEE', lines: [label, text] };

  // Wallet savings pots: money moving between the wallet and its own savings.
  if (/OWEALTH|\bCASHBOX\b|SPEND ?\+ ?SAVE|\bSAFEBOX\b|\bSAVE ?BOX\b|TARGET SAVINGS|\bAUTO-?SAVE\b/.test(H)) return { type: 'POT', lines: ['Savings pot', text] };

  // Airtime and data, which can name the phone number: keep only the network.
  if (/\bAIRTIME\b|\bMOBILE DATA\b|\bDATA (?:BUNDLE|PURCHASE|PLAN|SUBSCRIPTION)\b|\bVTU\b/.test(H)) {
    const net = NETWORKS.find(([re]) => re.test(H))?.[1];
    const what = /\bAIRTIME\b|\bVTU\b/.test(H) ? 'Airtime' : 'Mobile data';
    return { type: 'BILL', lines: [net ? `${what} · ${net}` : what, text] };
  }

  // A failed transfer coming back. Paired with the payment it reverses after import (pairReversals).
  if (!out && /\b(?:REVERSAL|REVERSED|RVSL)\b/.test(H)) return { type: '', lines: ['Transfer reversal', text] };

  // Wallet bill payments: "Betting | 12345 | SPORTYBET", "Electricity | | provider | 55.4 kWh".
  const bill = /^(BETTING|ELECTRICITY|CABLE ?TV|TV|INTERNET|WATER|EDUCATION|DATA)\s*\|(.*)$/i.exec(text);
  if (bill && out) {
    const kind = titled(bill[1]!);
    const who = bill[2]!.split('|').map(clean).find((p) => /^[A-Za-z][A-Za-z ._-]{2,}$/.test(p) && !/kwh|prepaid|postpaid/i.test(p));
    return { type: 'BILL', lines: [who && kind === 'Betting' ? `${kind} · ${titled(who.replace(/_/g, ' '))}` : kind, text] };
  }

  // Cash machines.
  if (/\bATM\b.*\b(?:WD|WDL|WITHDRAWAL|CASH)\b|\bCASH WITHDRAWAL\b/.test(H) && out) return { type: 'ATM', lines: [text] };

  // Card payments: "POS Buy on 03-08-2026@Psk*SHOP", "WEB Buy on ...@SHOP", "POS PURCHASE ... SHOP".
  const card = /\b(?:POS|WEB|ONLINE|CARD)\s*(?:BUY|PURCHASE|PMT|PAYMENT|TRAN)\b[^@]*@\s*(.+)$/i.exec(text);
  if (card) {
    const merchant = card[1]!.replace(/^(?:PSK|PAYSTACK|FLW|FLUTTERWAVE|PAYSTK|INTERSW|REMITA)\s*\*\s*/i, '').replace(/[_*-](?=[A-Z]*\d)[A-Z0-9]{5,}$/i, '').replace(/^[A-Z0-9]{2,4}-/i, '');
    return { type: 'VIS', lines: [clean(merchant) || text, text] };
  }

  // Paying a POS terminal or agent by transfer: could be cash out or a shop. Asked once, then learned.
  const pos = /TRANSFER TO POS TRANSFER\s*-?\s*([^|]+)/i.exec(text);
  if (pos) return { type: 'POS', lines: [`POS transfer · ${titled(pos[1]!)}`, text] };

  // Transfers. The name of the other side becomes the payee, so holder matching and "is this a person?" work.
  const toFrom = (name: string) => titled(name.replace(/,/g, ' ').replace(/\s*-\s*$/, ''));
  let m = /\bTRANSFER (TO|FROM)\s+(.+?)\s*\|\s*([^|]*?)\s*\|/i.exec(text); // OPay/Moniepoint: "Transfer to NAME | BANK | 123****456"
  if (m) return { type: /TO/i.test(m[1]!) ? 'BP' : 'CR', lines: [toFrom(m[2]!), clean(m[3]!)] };
  m = /\bNIP TRANSFER (?:REVERSAL )?TO\s+(.+?)\s*FROM\s*(.+)$/i.exec(text); // ALAT: "ALAT NIP TRANSFER TO X FROM Y"
  if (m && !/REVERSAL/i.test(H)) return { type: out ? 'BP' : 'CR', lines: [toFrom(out ? m[1]! : m[2]!), 'NIP transfer'] };
  m = /\bTRANSFER TO\s+(.+?)\s*FROM\s*(.+)$/i.exec(text); // "ALAT TRANSFER TO Y FROM X"
  if (m && !/REVERSAL/i.test(H)) return { type: out ? 'BP' : 'CR', lines: [toFrom(out ? m[1]! : m[2]!), 'Transfer'] };
  m = /^(?:NIP|FIP|NIBSS)\s*[:/]\s*([^-/|]+?)\s*[-/|]\s*(.*)$/i.exec(text); // "NIP:NAME-what for"
  if (m) return { type: out ? 'BP' : 'CR', lines: [toFrom(m[1]!), clean(m[2]!) || 'NIP transfer'] };
  m = /^(?:TRF|TRANSFER|MOB\s*TRF|FT)\s*(?:TO|FRM|FROM)\s*[:-]?\s*([A-Z][A-Z .'-]{3,}?)(?:\s*[|/,]|\s{2,}|$)/i.exec(text);
  if (m) return { type: out ? 'BP' : 'CR', lines: [toFrom(m[1]!), text] };
  return null;
}

/** Strip the charge prefix so a fee's text can be matched to the payment it was charged on. */
export const chargedOn = (raw: string): string => raw.toUpperCase().replace(/^(?:VAT|COMM|V\.A\.T)\s+/, '').replace(/\s+/g, ' ').trim();
