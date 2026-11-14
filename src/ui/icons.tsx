import {
  AirplaneTilt, ArrowBendUpLeft, ArrowDown, ArrowRight, ArrowUp, ArrowsClockwise, ArrowsLeftRight, Bank, Bell, BellRinging,
  Briefcase, Bus, CalendarBlank, CaretDown, CaretLeft, CaretRight, ChartBar, ChartLineUp, Check, CheckCircle, Clock,
  Coins, CreditCard, Devices, DotsThree, DownloadSimple, FileCsv, FilePdf, File as FileIcon, FilmSlate, Flag, ForkKnife, Funnel, Gauge, Gear, Gift,
  GlobeHemisphereWest, GraduationCap, Heartbeat, House, Info, Lightning, LockKey, MagnifyingGlass, Money, Moon,
  PencilSimple, PiggyBank, Plus, PlusCircle, PushPin, Question, Receipt, Scissors, ShieldCheck, ShoppingBag, ShoppingCart,
  Sliders, Sparkle, Sun, Tag, Target, Trash, TrendDown, TrendUp, UploadSimple, UsersThree, Wallet, Warning,
  WarningCircle, X, ListBullets, Table, Lightbulb, Scales, Fire, Confetti, ArrowCounterClockwise, Eye, Calendar, Rows, Trophy, Medal, Car, DeviceMobile, WifiHigh, Television, Drop, Buildings,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';

/**
 * Every icon the app uses, by name. Category icons are stored as these names in the database,
 * so a category's look survives backups and works on every device (unlike emoji).
 */
export const ICONS = {
  AirplaneTilt, ArrowBendUpLeft, ArrowDown, ArrowRight, ArrowUp, ArrowsClockwise, ArrowsLeftRight, Bank, Bell, BellRinging,
  Briefcase, Bus, CalendarBlank, CaretDown, CaretLeft, CaretRight, ChartBar, ChartLineUp, Check, CheckCircle, Clock,
  Coins, CreditCard, Devices, DotsThree, DownloadSimple, FileCsv, FilePdf, FileIcon, FilmSlate, Flag, ForkKnife, Funnel, Gauge, Gear, Gift,
  GlobeHemisphereWest, GraduationCap, Heartbeat, House, Info, Lightning, LockKey, MagnifyingGlass, Money, Moon,
  PencilSimple, PiggyBank, Plus, PlusCircle, PushPin, Question, Receipt, Scissors, ShieldCheck, ShoppingBag, ShoppingCart,
  Sliders, Sparkle, Sun, Tag, Target, Trash, TrendDown, TrendUp, UploadSimple, UsersThree, Wallet, Warning,
  WarningCircle, X, ListBullets, Table, Lightbulb, Scales, Fire, Confetti, ArrowCounterClockwise, Eye, Calendar, Rows, Trophy, Medal, Car, DeviceMobile, WifiHigh, Television, Drop, Buildings,
} satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof ICONS;

/** Icons a user can pick for their own categories. */
export const PICKABLE: IconName[] = [
  'ShoppingCart', 'ForkKnife', 'Bus', 'ShoppingBag', 'Lightning', 'ArrowsClockwise', 'House', 'UsersThree', 'GlobeHemisphereWest',
  'Heartbeat', 'Scissors', 'FilmSlate', 'GraduationCap', 'AirplaneTilt', 'Gift', 'Bank', 'Money', 'Receipt', 'Briefcase',
  'PiggyBank', 'CreditCard', 'Coins', 'Wallet', 'Tag', 'Sparkle', 'Target', 'Flag', 'Gauge',
];

interface IconProps {
  name: string;
  size?: number;
  weight?: IconWeight;
  className?: string;
}

/** Duotone by default — the two-tone look is what gives the interface its character. */
export function Icon({ name, size = 20, weight = 'duotone', className }: IconProps) {
  const C = (ICONS as Record<string, PhosphorIcon>)[name] ?? Question;
  return <C size={size} weight={weight} className={className} aria-hidden="true" />;
}
