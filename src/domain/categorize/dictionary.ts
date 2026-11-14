/**
 * Built-in UK merchant dictionary. First match wins, so specific entries come
 * before general ones. Patterns run against an UPPER-CASE haystack made of the
 * payee line plus the following description lines.
 *
 * [pattern, display name (null keeps the cleaned payee), category id, direction?]
 * Direction narrows an entry to money in ('in') or out ('out').
 *
 * To extend: add a line. Users can also teach the app from the UI; their rules
 * always beat this list.
 */
export type DictEntry = [pattern: string, name: string | null, category: string, dir?: 'in' | 'out', confidence?: number];

const D: DictEntry[] = [
  // ---- debt & credit (before generic "finance"/"card" words) ----
  ['ZILCH', 'Zilch', 'debt', 'out'],
  ['ZABLE', 'Zable', 'debt', 'out'], // Zable credit card: payments to it are card repayments
  ['KLARNA', 'Klarna', 'debt', 'out'],
  ['CLEARPAY|CLEAR PAY', 'Clearpay', 'debt', 'out'],
  ['LAYBUY', 'Laybuy', 'debt', 'out'],
  ['PAYPAL CREDIT', 'PayPal Credit', 'debt', 'out'],
  ['CAPITAL ONE|BARCLAYCARD|MBNA|NEWDAY|VANQUIS|MARBLES|AQUA CARD|TSB LOAN|LOAN REPAY|CREDIT CARD', null, 'debt', 'out'],
  ['STUDENT LOAN|SLC REPAY', 'Student Loans Company', 'debt', 'out'],
  ['SATSUMA|DRAFTY|LENDING STREAM|MONEYBOAT|PROVIDENT|CASH ?LENDER', null, 'debt', 'out'],

  // ---- savings & investing ----
  ['PAYWARD|KRAKEN', 'Kraken', 'savings', 'out'],
  ['COINBASE|BINANCE|CRYPTO\\.COM|TRADING ?212|FREETRADE|VANGUARD|HARGREAVES|NUTMEG|MOONFARE|AJ BELL|INTERACTIVE INV', null, 'savings', 'out'],
  ['MONZO POT|CHIP SAVINGS|PLUM SAVINGS|MARCUS|PREMIUM BONDS|NS ?& ?I', null, 'savings', 'out'],

  // ---- sending money abroad (LemFi was called Lemonade Finance until 2023; ACE is acemoneytransfer.com) ----
  ['LEMFI|LEMONADE FINANCE', 'LemFi', 'remittance', 'out'],
  ['ACE ?MONEY ?TRANSFER|ACEMONEYTRANSFER', 'ACE Money Transfer', 'remittance', 'out'],
  ['MONEY ?TRANSFER|WISE|TRANSFERWISE|REMITLY|WORLDREMIT|WESTERN UNION|MONEYGRAM|SENDWAVE|TAPTAP SEND|XOOM|PAYSEND|SMALL WORLD|SENDY', null, 'remittance', 'out'],

  // ---- income-side ----
  ['DWP|UNIVERSAL CREDIT|CHILD BENEFIT|STUDENT FINANCE|HMRC', null, 'benefits', 'in'],
  ['PAYPAL', 'PayPal', 'other-income', 'in', 0.75],
  ['REFUND|REVERSAL|CASHBACK', null, 'refunds', 'in'],

  // ---- government & legal ----
  ['UKVI|IHSC|HOME OFFICE|VISA FEE|HMRC|(?<!TFL\\.)GOV\\.UK|COUNCIL COURT|HM COURTS|PARKING CHARGE|PENALTY CHARGE|PCN', null, 'gov', 'out'],

  // ---- eating out (before Uber, groceries) ----
  ['UBER ?\\*? ?EATS|JUST ?EAT|DELIVEROO', null, 'eating-out'],
  ['MCDONALD|KFC|WINGSTOP|BURGER KING|SUBWAY|NANDO|DOMINO|PIZZA|WAGAMAMA|FIVE GUYS|GREGGS|(?<![-\\w])COSTA\\b|STARBUCKS|PRET A|CAFFE NERO|TIM HORTON|WENDY|POPEYES|DUNKIN|KRISPY', null, 'eating-out'],
  ['KEBAB|TAKEAWAY|RESTAURANT|CAFE|CAFÉ|COFFEE|BAKERY|BAKERS|DINER|GRILL|CHICKEN|CURRY|SHAWARMA|SUSHI|BISTRO|TEA ROOM|DESSERT', null, 'eating-out'],

  // ---- transport ----
  ['UBER|UBR\\*', 'Uber', 'transport'],
  ['BOLT\\.EU|\\bBOLT\\b|FREE ?NOW|ADDISON LEE', null, 'transport'],
  ['BEENETWORK|BEE NETWORK|TFGM|METROLINK', 'Bee Network', 'transport'],
  ['\\bTFL\\b|TRANSPORT FOR LONDON', 'TfL', 'transport'],
  ['TRAINLINE|AVANTI|LNER|NORTHERN TRAINS|TRANSPENNINE|NATIONAL RAIL|GWR|SOUTHWESTERN|THAMESLINK|CROSSCOUNTRY|EAST MIDLANDS RAIL|CHILTERN|SOUTHEASTERN|SCOTRAIL|MTIS', null, 'transport'],
  ['NATIONAL EXPRESS|MEGABUS|FLIXBUS|STAGECOACH|FIRST BUS|ARRIVA', null, 'transport'],
  ['\\bSHELL\\b|\\bESSO\\b|TEXACO|PETROL|\\bFUEL\\b|\\bBP \\d|APPLEGREEN|MFG ', null, 'transport'],
  ['PARKING|\\bNCP\\b|RINGGO|PAYBYPHONE|JUSTPARK|DVLA|CAR WASH|HALFORDS|KWIK FIT', null, 'transport'],
  ['\\bLIME\\b|TIER MOB|VOI TECH', null, 'transport'],

  // ---- subscriptions ----
  ['AMAZON ?PRIME|PRIME VIDEO', 'Amazon Prime', 'subscriptions'],
  ['NETFLIX', 'Netflix', 'subscriptions'],
  ['SPOTIFY', 'Spotify', 'subscriptions'],
  ['DISNEY ?PLUS|DISNEY\\+|NOW ?TV|PARAMOUNT|APPLE TV|BRITBOX|DAZN|CRUNCHYROLL', null, 'subscriptions'],
  ['APPLE\\.COM/BILL|ITUNES|APPLE\\.COM|ICLOUD', 'Apple', 'subscriptions'],
  ['^APPLE$', 'Apple', 'subscriptions', 'out', 0.8], // Revolut prints App Store / iCloud charges as plain "Apple"
  ['GOOGLE ?(ONE|STORAGE|PLAY|YOUTUBE)|YOUTUBE', 'Google', 'subscriptions'],
  ['ANTHROPIC|CLAUDE\\.AI|OPENAI|CHATGPT|MIDJOURNEY|HIGGSFIELD|PERPLEXITY|CURSOR', null, 'subscriptions'],
  ['NAME-?CHEAP|GODADDY|HOSTINGER|MICROSOFT|XBOX|OFFICE ?365|ADOBE|DROPBOX|CANVA|NOTION|GITHUB|PATREON|DUOLINGO|AUDIBLE|KINDLE UNLIMITED|NORDVPN|PROTON|1PASSWORD|BITWARDEN', null, 'subscriptions'],

  // ---- bills & utilities ----
  ['OCTOPUS ENERGY|BRITISH GAS|\\bEDF\\b|E\\.?ON NEXT|SCOTTISH POWER|\\bOVO\\b|SHELL ENERGY|UTILITA|UTILITY WAREHOUSE|SSE ', null, 'bills'],
  ['SEVERN TRENT|UNITED UTILITIES|THAMES WATER|YORKSHIRE WATER|ANGLIAN WATER|WELSH WATER|SOUTHERN WATER|WATER PLC', null, 'bills'],
  ['COUNCIL TAX|TV LICEN|TVL', null, 'bills'],
  ['VODAFONE|\\bEE\\b|\\bTHREE\\b|\\bO2\\b|GIFFGAFF|LEBARA|LYCAMOBILE|VOXI|SMARTY|TESCO MOBILE|ID MOBILE|SKY ?(BROADBAND|MOBILE|DIGITAL)|\\bBT\\b|VIRGIN MEDIA|PLUSNET|TALKTALK|HYPEROPTIC|COMMUNITY FIBRE|NOW BROADBAND', null, 'bills'],
  ['INSURANCE|AVIVA|ADMIRAL|DIRECT LINE|LEGAL ?& ?GENERAL|HASTINGS|\\bAXA\\b|LV=|CHURCHILL|COMPARE THE MARKET', null, 'bills'],

  // ---- housing ----
  ['\\bRENT\\b|LANDLORD|LETTING|ESTATE AGENT|RIGHTMOVE|MORTGAGE|SPAREROOM|OPENRENT', null, 'housing'],

  // ---- health ----
  ['BOOTS|SUPERDRUG|PHARMACY|LLOYDS PHARM|NHS|DENTAL|DENTIST|OPTICIAN|SPECSAVERS|VISION EXPRESS|DOCTOR|CLINIC|DIAGNOSTIC|PHYSIO|PUREGYM|\\bTHE GYM\\b|\\bGYM\\b|DAVID LLOYD|FITNESS|ANYTIME FIT', null, 'health'],

  // ---- personal care ----
  ['BARBER|\\bHAIR|SALON|NAILS|BEAUTY|\\bSPA\\b|LASHES|BROWS|TATTOO|WAXING|THREADING', null, 'personal-care'],

  // ---- entertainment ----
  ['CINEMA|\\bVUE\\b|ODEON|CINEWORLD|SHOWCASE|EVERYMAN|STEAM|TENPIN|BOWL|PLAYSTATION|\\bPSN\\b|NINTENDO|TICKETMASTER|SEETICKETS|EVENTBRITE|PHOTOBO|LEISU|ARCADE|ESCAPE ROOM|TRAMPOLINE|LASER|BINGO|BET365|PADDY POWER|SKYBET|WILLIAM HILL|LADBROKES|BETFAIR|UNIBET', null, 'entertainment'],

  // ---- education ----
  ['UNIVERSITY|UNI OF|COLLEGE|SCHOOL|UDEMY|COURSERA|SKILLSHARE|PEARSON|OPEN UNIVERSITY|WATERSTONES|\\bTUITION\\b', null, 'education'],

  // ---- travel ----
  ['RYANAIR|EASYJET|BRITISH AIRWAYS|WIZZ|JET2|TUI\\b|BOOKING\\.COM|AIRBNB|EXPEDIA|HOTEL|TRAVELODGE|PREMIER INN|EUROSTAR|SKYSCANNER|HOLIDAY|HOSTEL|AIRPORT|EMIRATES|QATAR AIRWAYS|TURKISH AIR|AIR PEACE|VIRGIN ATLANTIC', null, 'travel'],

  // ---- gifts & giving ----
  ['\\bGIFTS?\\b|CHARITY|OXFAM|BRITISH HEART|CANCER RESEARCH|SAVE THE CHILDREN|UNICEF|\\bTITHE\\b|CHURCH|DONATION|GOFUNDME|JUSTGIVING|RCCG|REDEEMED|MOSQUE|ZAKAT|SADAQAH|ISLAMIC RELIEF|MUSLIM AID|SALVATION ARMY', null, 'gifts'],

  // ---- online marketplaces that would otherwise match the "express"/"mart" grocery words ----
  ['ALIEXPRESS', 'AliExpress', 'shopping'],

  // ---- groceries ----
  ['\\bASDA\\b', 'Asda', 'groceries'],
  ['TESCO', 'Tesco', 'groceries'],
  ['SAINSBURY', "Sainsbury's", 'groceries'],
  ['MORRISONS|WM MORRISON', 'Morrisons', 'groceries'],
  ['\\bALDI\\b', 'Aldi', 'groceries'],
  ['\\bLIDL\\b', 'Lidl', 'groceries'],
  ['CO-?OP\\b|CO-OPERATIVE|COOP FOOD', 'Co-op', 'groceries'],
  ['WAITROSE|OCADO|ICELAND|MARKS ?(&|AND) ?SPENCER|\\bM ?& ?S\\b|FARMFOODS|FARM FOODS', null, 'groceries'],
  // National chains by name; independents by what they say they are. No individual local shops: those differ
  // for every user and are learned from each user's own choices instead.
  ['FAMILY SHOPPER|SUPERSTORE|SUPERMARKET|CONVENIEN|WHOLESA|\\bMART\\b|\\bFOODS?\\b|GO LOCAL|\\bSPAR\\b|LONDIS|COSTCUTTER|\\bNISA\\b|ONE STOP|BARGAIN BOOZE|BEST ?ONE|PREMIER STORES|NEWSAGENT|GROCER|FRUIT|\\bVEG|BUTCHER|\\bMEATS?\\b|HALAL|AFRICAN|ASIAN|ORIENTAL|DISCOUNT ST|OFF LICEN|OFF LIC\\b|LIQUOR', null, 'groceries'],

  // ---- shopping ----
  ['AMAZON|AMZN', 'Amazon', 'shopping'],
  ['BACK ?MARKET', 'Back Market', 'shopping'], // refurbished electronics marketplace
  ['ALIEXPRESS|EBAY|ARGOS|PRIMARK|\\bNEXT\\b|H ?(&|AND) ?M\\b|^HM\\b|ZARA|TK ?MAXX|SHEIN|TEMU|ASOS|BOOHOO|VINTED|ETSY|CURRYS|IKEA|B ?(&|AND) ?M\\b|HOME BARGAINS|POUNDLAND|POUNDSTRETCHER|POUNDWORLD|WILKO|SPORTS DIRECT|JD SPORTS|NIKE|ADIDAS|SMYTHS|WH ?SMITH|SUPERDRY|RIVER ISLAND|NEW LOOK|FOOTLOCKER|CROCS|MOBILE ACC|PHONE CASE|ESCOOTER|SCOOTER|WORKWEA|THE RANGE|SHOE|CLOTHES|FASHION|ELECTRONIC|E-?BIKE', null, 'shopping'],

  // ---- fees ----
  ['NON-STERLING|OVERDRAFT|ACCOUNT FEE|MONTHLY FEE|TRANSACTION FEE|CASH ?(WITHDRAWAL)? FEE|CHARGE', null, 'fees', 'out'],
];

export interface CompiledDict { re: RegExp; name: string | null; category: string; dir?: 'in' | 'out'; confidence: number }
export const DICTIONARY: CompiledDict[] = D.map(([p, name, category, dir, confidence]) => ({
  re: new RegExp(p),
  name,
  category,
  dir,
  confidence: confidence ?? 0.92,
}));
