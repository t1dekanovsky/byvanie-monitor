/**
 * Parsovanie textov, ktoré vyzerajú rovnako na všetkých zdrojoch (izby, plocha,
 * energie v popise). Formát ceny sa medzi portálmi líši, ten si rieši každý zdroj sám.
 */

/**
 * Text bez diakritiky a malými písmenami. Inzeráty sa píšu všelijako – „päťizbový"
 * aj „patizbovy" – a porovnávať sa musia rovnako.
 */
export function deaccent(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Zjednotí biele znaky vrátane nezlomiteľnej medzery. */
export function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Slovenský zápis sumy: "850,- €", "1.100,- €", "950,- €/mes.", "1 250 €", "850,50 €".
 * Bodka aj medzera sú oddeľovač tisícov, čiarka desatinná – a ",-" znamená
 * "toľko celých eur", nie desatinnú časť.
 */
export function parseEuroAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const text = raw.replace(/\u00a0/g, ' ');
  const match = text.match(/\d[\d\s.]*(?:,(?:\d+|-))?/);
  if (!match) return null;

  const token = match[0].replace(/\s/g, '').replace(/,-$/, '');
  const [whole = '', fraction] = token.split(',');
  const digits = whole.replace(/\./g, '');
  if (digits === '') return null;

  const value = Number(fraction === undefined ? digits : digits + '.' + fraction);
  return Number.isFinite(value) ? value : null;
}

/**
 * Dispozícia slovom. Portály ju píšu číslom, na Bazoši ju súkromník napíše aj
 * takto – "trojizbový byt". Kľúče sú bez diakritiky, text sa porovnáva cez `deaccent`.
 */
const ROOM_WORDS: Readonly<Record<string, number>> = {
  jedno: 1,
  dvoj: 2,
  troj: 3,
  stvor: 4,
  pat: 5,
  sest: 6,
};

const ROOM_WORD_PATTERN = new RegExp('(' + Object.keys(ROOM_WORDS).join('|') + ')\\s*-?\\s*izb');

/**
 * "3-izbový byt", "5 a viac izbový byt", "4 izbový rodinný dom", "trojizbový byt",
 * "1,5-izbový byt", "3i byt".
 */
export function parseRooms(...texts: (string | null | undefined)[]): number | null {
  for (const text of texts) {
    if (!text) continue;
    // Zlomok musí byť v zázname, inak by sa z „1,5-izbový" prečítala päťka. Pol
    // izby navyše dispozíciu nemení, tak sa zaokrúhľuje nadol: 3,5 izby je trojizbák.
    const rooms = text.match(/(\d+(?:[.,]\d+)?)\s*(?:a\s*viac\s*)?[-–—]?\s*izb/i);
    if (rooms?.[1]) {
      const value = Math.floor(Number(rooms[1].replace(',', '.')));
      if (Number.isFinite(value) && value > 0) return value;
    }
  }

  for (const text of texts) {
    if (!text) continue;
    const word = deaccent(text).match(ROOM_WORD_PATTERN)?.[1];
    if (word !== undefined) return ROOM_WORDS[word] as number;
  }

  // Až ako záloha – inak by "3i" kdekoľvek v názve prebilo poctivý údaj o dispozícii.
  for (const text of texts) {
    if (!text) continue;
    const short = text.match(/(\d+)\s*i\b/i);
    if (short?.[1]) return Number(short[1]);
  }

  return null;
}

/** "76 m2", "100 m²", "86,5 m2", "79.02 m²". */
export function parseArea(...texts: (string | null | undefined)[]): number | null {
  for (const text of texts) {
    if (!text) continue;
    const match = text.replace(/\u00a0/g, ' ').match(/(\d+(?:[.,]\d+)?)\s*m\s*(?:2|²)/i);
    if (match?.[1]) {
      const value = Number(match[1].replace(',', '.'));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * Text bez diakritiky, bez nezlomiteľných medzier a malými písmenami – inzeráty
 * píšu "vo výške" aj "vo vyske" a hľadá sa v oboch rovnako.
 */
function flatten(texts: readonly (string | null | undefined)[]): string {
  return deaccent(texts.filter(Boolean).join(' ').replace(/\u00a0/g, ' '));
}

/** Suma v slovenskom zápise, aj s koncovkou ",-". */
const AMOUNT = String.raw`(\d[\d\s.]*(?:,(?:\d+|-))?)`;

/** Ako sa v inzerátoch volá to, čo sa k nájmu pripočítava. Bez diakritiky. */
const ENERGY_LABEL = String.raw`(?:energi|zaloh|poplatk|sluzb)\w*`;

/**
 * Mesačné energie mimo tohto rozsahu sú takmer isto niečo iné – kaucia, ročné
 * vyúčtovanie alebo samotný nájom, ktorý sa do vzorky pripletie.
 */
const MIN_ENERGIES_EUR = 30;
const MAX_ENERGIES_EUR = 600;

/**
 * Suma energií z textu inzerátu: "650 € + 200 € energie", "energie 200 €",
 * "+ 150 EUR za energie", "energie: 180,- €", "zálohy 250 €/mes", "poplatky 180 EUR".
 * Vracia null, keď inzerát sumu neuvádza alebo je zjavne o niečom inom. Či je cena
 * vrátane energií, hovorí `priceBasis`, nie táto funkcia.
 */
export function parseEnergies(...texts: (string | null | undefined)[]): number | null {
  const joined = flatten(texts);

  const patterns = [
    new RegExp(String.raw`\+\s*${AMOUNT}\s*(?:€|eur)\s*(?:/\s*mes\.?)?\s*(?:za\s+)?${ENERGY_LABEL}`),
    new RegExp(
      String.raw`${ENERGY_LABEL}(?:\s+(?:na|za)\s+\w+)?\s*(?:vo\s*vyske|zalohovo|:|–|-|cca|od)?\s*${AMOUNT}\s*(?:€|eur)`,
    ),
    new RegExp(String.raw`${AMOUNT}\s*(?:€|eur)\s*(?:/\s*mes\.?)?\s*(?:za\s+)?${ENERGY_LABEL}`),
  ];

  for (const pattern of patterns) {
    const value = parseEuroAmount(joined.match(pattern)?.[1]);
    if (value === null) continue;
    return value >= MIN_ENERGIES_EUR && value <= MAX_ENERGIES_EUR ? value : null;
  }

  return null;
}

/**
 * Ako sa v texte volá suma, ktorá už kryje všetko – nájom aj energie. Bez
 * diakritiky, lebo text sa porovnáva normalizovaný.
 */
const TOTAL_LABEL = String.raw`(?:spolu|celkom|celkovo|dokopy|vratane\s+(?:energi\w*|vsetkeho|vsetkych\s+poplatkov|poplatkov|sluzieb)|s\s+energiami)`;

/**
 * Medzi menovkou a sumou stojí často ešte pár slov: "spolu s energiami a dvomi
 * garážovými státiami 1.300,-eur". Sú to slová, nie čísla, takže samotnú sumu
 * nepohltia.
 *
 * Cez pár slov sa ale prepašuje aj celkom iná suma – "celkom pri podpise zmluvy:
 * 4 500 €" je nájom aj depozit aj provízia naraz, nie mesačná cena. Tie slová
 * medzeru zastavia.
 */
const NOT_MONTHLY_WORD = String.raw`(?!podpis|depozit|kauci|zabezpek|provizi|nastahovan)`;

const TOTAL_FILLER = String.raw`(?:\s+${NOT_MONTHLY_WORD}[a-z]+){0,5}`;

/** Spojka medzi menovkou a sumou: "vrátane energií je 1450€", "spolu: 1 300 €". */
const TOTAL_LINK = String.raw`\s*(?:je|to|:|=|–|-|cca)?\s*`;

/** Ročné vyúčtovanie ani ročný nájom nie sú mesačná suma. */
const NOT_YEARLY = String.raw`(?!\s*(?:/\s*rok|rocne|za\s+rok))`;

const STATED_TOTAL = new RegExp(
  TOTAL_LABEL + TOTAL_FILLER + TOTAL_LINK + AMOUNT + String.raw`\s*(?:€|eur)` + NOT_YEARLY,
  'g',
);

/**
 * Suma, ktorú inzerát vydáva za cenu spolu: "spolu 1 300 €", "celkom 1 400 €",
 * "vrátane energií je 1450€", "nájomné s energiami 1400 €". Vracia najvyššiu
 * nájdenú – keď si text protirečí, platí to drahšie číslo, nie to lákavejšie.
 *
 * Či sa suma vôbec dá použiť, rozhoduje až filter: musí byť vyššia než cena
 * z karty a nesmie byť jej násobkom, inak by ju prepísala cena predaja.
 */
export function parseStatedTotal(...texts: (string | null | undefined)[]): number | null {
  const joined = flatten(texts);

  let best: number | null = null;
  STATED_TOTAL.lastIndex = 0;

  for (let hit = STATED_TOTAL.exec(joined); hit !== null; hit = STATED_TOTAL.exec(joined)) {
    const value = parseEuroAmount(hit[1]);
    if (value !== null && (best === null || value > best)) best = value;
  }

  return best;
}

/** "20.08.2026" -> ISO timestamp o polnoci UTC. */
export function parseSlovakDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!match) return null;

  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
