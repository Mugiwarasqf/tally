import type { CatSource, Rule } from '../types';
import { TRANSFER, UNSORTED_IN, UNSORTED_OUT } from './categories';
import type { Described } from './merchant';
import { slug } from './merchant';

export interface CatInput {
  type: string;
  amount: number;
  d: Described;
}
export interface CatContext {
  rules: Rule[];
  /** Account holder names seen on imported statements, to spot transfers between your own accounts. */
  holders: string[];
}
export interface CatResult {
  categoryId: string;
  source: CatSource;
  confidence: number;
  reason: string;
}

/** Confidence below this lands in the review queue. */
export const REVIEW_THRESHOLD = 0.7;

const words = (s: string): string[] => slug(s).split(' ').filter(Boolean);

/**
 * True when a payee name looks like one of the account holders ("J Example", "Jordan Quinn"). Holder names come
 * from each user's own statements; nothing about any particular person is built in.
 */
export function matchesHolder(payee: string, holders: string[]): boolean {
  const p = words(payee);
  if (!p.length) return false;
  for (const holder of holders) {
    const h = words(holder);
    if (h.length < 2) continue;
    const first = h[0]!;
    const last = h[h.length - 1]!;
    const pre = (a: string, b: string, min = 3) => a.length >= min && (b.startsWith(a) || a.startsWith(b));
    // The holder's first name alone ("Jordan"), as some references show it. Only when nothing else is written:
    // "Jordan Smith" is a different person.
    if (p.length === 1 && pre(p[0]!, first, 5)) return true;
    // Initial + surname: "J Example"
    if (p[0]!.length === 1 && p[0] === first[0] && p[1] && pre(p[1], last, 4)) return true;
    // Initials + surname: "J Q Example" (each initial matches a holder name in order)
    if (p.length >= 3 && p.slice(0, -1).every((w, i) => w.length === 1 && w === h[i]?.[0]) && pre(p.at(-1)!, last, 4)) return true;
    // First name + any other holder word, allowing bank truncation: "Jordan Quinn", "Jordan Exampl"
    if (p[1] && pre(p[0]!, first, 4) && h.slice(1).some((w) => pre(p[1]!, w, 4))) return true;
  }
  return false;
}

const BUSINESS_WORDS = /\b(ltd|limited|plc|inc|llc|services?|card|bank|payments?|pay|finance|store|stores|shop|market|foods?|wholesale|cafe|bakery|restaurant|pharmacy|group|co|company|uk|mobile|telecom|insurance|supermarket|express|local|solutions|systems|holdings|trading|energy|council|university|college|school|church|mosque)\b/i;

/** "Sam Carter" — two or three plain name words and nothing that smells like a company. */
export function looksLikePerson(payee: string): boolean {
  if (BUSINESS_WORDS.test(payee) || /\d/.test(payee)) return false;
  const w = payee.split(/\s+/).filter(Boolean);
  return w.length >= 2 && w.length <= 4 && w.every((x) => /^[A-Za-z][A-Za-z'’.-]*$/.test(x));
}

function applyRules(input: CatInput, rules: Rule[]): CatResult | null {
  const hay = `${input.d.merchant} ${input.d.raw}`.toLowerCase();
  // User rules first (most recent wins), then learned ones.
  const ordered = [...rules].sort((a, b) => (a.kind === b.kind ? b.createdAt - a.createdAt : a.kind === 'user' ? -1 : 1));
  for (const r of ordered) {
    if (r.dir && (r.dir === 'out') !== input.amount < 0) continue;
    let hit = false;
    if (r.match === 'merchant') hit = input.d.mkey === r.pattern;
    else if (r.match === 'contains') hit = hay.includes(r.pattern.toLowerCase());
    else {
      try {
        hit = new RegExp(r.pattern, 'i').test(hay);
      } catch {
        hit = false;
      }
    }
    if (hit) {
      return r.kind === 'user'
        ? { categoryId: r.categoryId, source: 'rule', confidence: 1, reason: `Your rule: “${r.pattern}”` }
        : { categoryId: r.categoryId, source: 'learned', confidence: 0.95, reason: `Learned from your earlier choice for ${input.d.merchant}` };
    }
  }
  return null;
}

export function categorize(input: CatInput, ctx: CatContext): CatResult {
  const { type, amount, d } = input;
  const out = amount < 0;

  const ruled = applyRules(input, ctx.rules);
  if (ruled) return ruled;

  if (type === 'POT') return { categoryId: TRANSFER, source: 'own', confidence: 0.97, reason: 'Moving money between the account and its own savings pot' };
  if (type === 'FEE') return { categoryId: 'fees', source: 'heuristic', confidence: 0.95, reason: 'Fee charged by the bank' };
  if (type === 'ATM') return { categoryId: 'cash', source: 'heuristic', confidence: 0.97, reason: 'Cash machine withdrawal' };
  if (d.mkey === 'cash deposit') return { categoryId: 'other-income', source: 'heuristic', confidence: 0.6, reason: 'Cash paid in — check where it came from' };
  if (d.mkey === 'non sterling fee') return { categoryId: 'fees', source: 'heuristic', confidence: 0.98, reason: 'Foreign-currency card fee' };

  if (d.otherAccount) {
    return { categoryId: TRANSFER, source: 'heuristic', confidence: 0.75, reason: 'Transfer to or from another account — change it if this was a payment to someone else' };
  }
  if (['BP', 'CR', 'OBP', 'VRP', 'TFR', 'DD', 'SO'].includes(type) && matchesHolder(d.payee, ctx.holders)) {
    return { categoryId: TRANSFER, source: 'own', confidence: 0.85, reason: 'The name matches the account holder — treated as moving your own money' };
  }

  if (d.dict) {
    return { categoryId: d.dict.category, source: 'dictionary', confidence: d.dict.confidence, reason: `Merchant: ${d.dict.name ?? d.merchant}` };
  }

  const h = d.haystack;
  if (!out && /\b(WAGES|SALARY|PAYROLL|PAYE)\b/.test(h)) return { categoryId: 'salary', source: 'heuristic', confidence: 0.9, reason: 'Reference mentions wages or salary' };
  if (!out && /\b(REVERSAL|REFUND|RETURNED)\b/.test(h)) return { categoryId: 'refunds', source: 'heuristic', confidence: 0.8, reason: 'Looks like a reversal or refund' };
  if (/\bINTEREST\b/.test(h)) return out ? { categoryId: 'fees', source: 'heuristic', confidence: 0.8, reason: 'Interest charge' } : { categoryId: 'interest', source: 'heuristic', confidence: 0.8, reason: 'Interest paid to you' };
  if (!out && type === 'VIS') return { categoryId: 'refunds', source: 'heuristic', confidence: 0.6, reason: 'A card payment coming back in is usually a refund' };
  if (type === 'DD' || type === 'SO') return { categoryId: 'bills', source: 'heuristic', confidence: 0.55, reason: type === 'DD' ? 'Direct debit' : 'Standing order' };

  // A payment to or from a person could be rent, a loan, a split bill or a gift. Never assume: it goes to the
  // review queue once, and the user's choice becomes a rule for that person from then on.
  if (['BP', 'CR', 'OBP'].includes(type) && looksLikePerson(d.payee)) {
    return out
      ? { categoryId: 'family', source: 'heuristic', confidence: 0.65, reason: 'Payment to a person — tell Tally what it was for' }
      : { categoryId: 'from-people', source: 'heuristic', confidence: 0.65, reason: 'Payment from a person — tell Tally what it was for' };
  }

  return { categoryId: out ? UNSORTED_OUT : UNSORTED_IN, source: 'none', confidence: 0, reason: 'No rule or known merchant matched' };
}
