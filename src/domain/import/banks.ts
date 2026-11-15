/**
 * Banks and e-money firms the generic PDF reader can name from a statement's own text. National institutions
 * only, never anything local or personal. Keys are matched against text with spaces removed and lower-cased,
 * so "Guaranty Trust Bank" is "guarantytrustbank". More specific keys come first.
 */
export const BANKS: Array<[key: string, name: string]> = [
  // United Kingdom
  ['firstdirect', 'first direct'], ['hsbc', 'HSBC'], ['barclays', 'Barclays'], ['lloyds', 'Lloyds'], ['halifax', 'Halifax'],
  ['bankofscotland', 'Bank of Scotland'], ['natwest', 'NatWest'], ['royalbankofscotland', 'Royal Bank of Scotland'],
  ['ulsterbank', 'Ulster Bank'], ['santander', 'Santander'], ['nationwide', 'Nationwide'], ['monzo', 'Monzo'],
  ['starling', 'Starling'], ['tsb', 'TSB'], ['metrobank', 'Metro Bank'], ['co-operativebank', 'Co-operative Bank'],
  ['cooperativebank', 'Co-operative Bank'], ['virginmoney', 'Virgin Money'], ['revolut', 'Revolut'],
  ['wise', 'Wise'], ['kroo', 'Kroo'], ['zopa', 'Zopa'], ['tide', 'Tide'], ['danske', 'Danske Bank'], ['coventrybuilding', 'Coventry BS'],
  ['skiptonbuilding', 'Skipton BS'], ['yorkshirebuilding', 'Yorkshire BS'], ['clydesdale', 'Clydesdale Bank'], ['aib', 'AIB'],

  // Nigeria (commercial banks, then digital banks and wallets)
  ['guarantytrust', 'GTBank'], ['gtbank', 'GTBank'], ['gtco', 'GTBank'], ['zenithbank', 'Zenith Bank'],
  ['accessbank', 'Access Bank'], ['firstbankofnigeria', 'First Bank'], ['firstbanknigeria', 'First Bank'], ['firstbank.ng', 'First Bank'],
  ['unitedbankforafrica', 'UBA'], ['ubagroup', 'UBA'], ['alat.ng', 'ALAT by Wema'], ['wemabank', 'Wema Bank'],
  ['fidelitybank', 'Fidelity Bank'], ['firstcitymonument', 'FCMB'], ['fcmb', 'FCMB'], ['sterlingbank', 'Sterling Bank'],
  ['unionbank', 'Union Bank'], ['stanbicibtc', 'Stanbic IBTC'], ['ecobank', 'Ecobank'], ['polarisbank', 'Polaris Bank'],
  // Globus, Lotus, Optimus and Providus must come before "usbank" below, which their names contain.
  ['providusbank', 'Providus Bank'], ['globusbank', 'Globus Bank'], ['lotusbank', 'Lotus Bank'], ['optimusbank', 'Optimus Bank'], ['keystonebank', 'Keystone Bank'], ['jaizbank', 'Jaiz Bank'], ['titantrust', 'Titan Trust Bank'],
  ['kudabank', 'Kuda'], ['kuda.com', 'Kuda'], ['moniepoint', 'Moniepoint'], ['palmpay', 'PalmPay'], ['opay', 'OPay'],
  ['fairmoney', 'FairMoney'],

  // United States
  ['bankofamerica', 'Bank of America'], ['wellsfargo', 'Wells Fargo'], ['jpmorganchase', 'Chase'], ['chase', 'Chase'],
  ['citibank', 'Citi'], ['capitalone', 'Capital One'], ['usbank', 'U.S. Bank'], ['pncbank', 'PNC'], ['tdbank', 'TD Bank'],
  ['allybank', 'Ally'], ['navyfederal', 'Navy Federal'], ['charlesschwab', 'Charles Schwab'], ['discoverbank', 'Discover'],
  ['chime', 'Chime'], ['sofibank', 'SoFi'],
];

/**
 * Product names that only one firm uses, for statements that never print the firm's own name (some wallet apps
 * put it only in a logo). Matched anywhere in the statement, after the bank names above have found nothing.
 */
export const PRODUCTS: Array<[key: string, name: string]> = [
  ['owealth', 'OPay'],
];

export function bankFrom(flatTexts: string[], everywhere: string[] = []): string {
  for (const t of flatTexts) {
    const hit = BANKS.find(([k]) => t.includes(k));
    if (hit) return hit[1];
  }
  // A bank's web address (alat.ng) is specific enough to trust wherever it is printed, footers included.
  for (const t of everywhere) {
    const hit = [...BANKS.filter(([k]) => k.includes('.')), ...PRODUCTS].find(([k]) => t.includes(k));
    if (hit) return hit[1];
  }
  return '';
}
