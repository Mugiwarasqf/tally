import type { Category, CategoryKind } from '../types';

type Seed = [id: string, name: string, icon: string, kind: CategoryKind, slot: number | null, fixed: boolean];

// Slots 0-7 map to the eight validated chart hues. Only the commonest spending
// categories get one; the rest stay neutral and are told apart by icon + name,
// so colour is never the only way to identify a category.
const SEED: Seed[] = [
  ['groceries', 'Groceries', 'ShoppingCart', 'expense', 0, false],
  ['eating-out', 'Eating out', 'ForkKnife', 'expense', 1, false],
  ['transport', 'Transport', 'Bus', 'expense', 2, false],
  ['shopping', 'Shopping', 'ShoppingBag', 'expense', 3, false],
  ['bills', 'Bills & utilities', 'Lightning', 'expense', 4, true],
  ['subscriptions', 'Subscriptions', 'ArrowsClockwise', 'expense', 5, true],
  ['housing', 'Housing', 'House', 'expense', 6, true],
  ['family', 'Family & friends', 'UsersThree', 'expense', 7, false],
  ['remittance', 'Sending money abroad', 'GlobeHemisphereWest', 'expense', null, false],
  ['health', 'Health & fitness', 'Heartbeat', 'expense', null, false],
  ['personal-care', 'Personal care', 'Scissors', 'expense', null, false],
  ['entertainment', 'Entertainment', 'FilmSlate', 'expense', null, false],
  ['education', 'Education', 'GraduationCap', 'expense', null, false],
  ['travel', 'Travel & holidays', 'AirplaneTilt', 'expense', null, false],
  ['gifts', 'Gifts & giving', 'Gift', 'expense', null, false],
  ['gov', 'Government & legal', 'Bank', 'expense', null, false],
  ['cash', 'Cash withdrawals', 'Money', 'expense', null, false],
  ['fees', 'Fees & charges', 'Receipt', 'expense', null, false],
  ['unsorted-out', 'Uncategorised spend', 'Question', 'expense', null, false],

  ['salary', 'Salary & wages', 'Briefcase', 'income', null, false],
  ['benefits', 'Benefits & tax refunds', 'Bank', 'income', null, false],
  ['from-people', 'Received from people', 'UsersThree', 'income', null, false],
  ['refunds', 'Refunds & reversals', 'ArrowBendUpLeft', 'income', null, false],
  ['interest', 'Interest', 'TrendUp', 'income', null, false],
  ['other-income', 'Side income & other', 'PlusCircle', 'income', null, false],
  ['unsorted-in', 'Uncategorised income', 'Question', 'income', null, false],

  ['transfer', 'Own-account transfers', 'ArrowsLeftRight', 'transfer', null, false],
  ['savings', 'Savings & investing', 'PiggyBank', 'saving', null, false],
  ['debt', 'Debt repayments', 'CreditCard', 'debt', null, true],
];

/** Essentials by default; everything else is discretionary. Every default can be changed in Settings. */
const NEEDS = new Set(['groceries', 'bills', 'housing', 'transport', 'health', 'education', 'gov', 'fees', 'remittance']);

export const DEFAULT_CATEGORIES: Category[] = SEED.map(([id, name, icon, kind, slot, fixed], order) => ({
  id, name, icon, kind, slot, fixed, order, system: true,
  ...(kind === 'expense' ? { bucket: NEEDS.has(id) ? ('needs' as const) : ('wants' as const) } : {}),
}));

/** Needs or wants for a spending category (user-added categories default to wants). */
export const bucketOf = (c: Category | undefined): 'needs' | 'wants' => c?.bucket ?? (NEEDS.has(c?.id ?? '') ? 'needs' : 'wants');

/**
 * Categories that are one-offs by nature (visa fees, fines, court costs). They count in what you spent, but never
 * in what you "usually" spend, so a £3,000 visa bill doesn't become a £1,000-a-month budget line.
 */
export const ONE_OFF = new Set(['gov']);

export const UNSORTED_OUT = 'unsorted-out';
export const UNSORTED_IN = 'unsorted-in';
export const TRANSFER = 'transfer';
export const DEBT = 'debt';

/** Categories whose spend counts as "spending" (everything else is income, transfer, saving or debt). */
export const isSpending = (c: Category | undefined): boolean => c?.kind === 'expense';
