/**
 * Parsovanie textov, ktoré vyzerajú rovnako na oboch portáloch (izby, plocha,
 * energie v popise). Formát ceny sa medzi portálmi líši, ten si rieši každý zdroj sám.
 */

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

/** "3-izbový byt", "5 a viac izbový byt", "4 izbový rodinný dom", "3i byt". */
export function parseRooms(...texts: (string | null | undefined)[]): number | null {
  for (const text of texts) {
    if (!text) continue;
    const rooms = text.match(/(\d+)\s*(?:a\s*viac\s*)?[-–—]?\s*izb/i);
    if (rooms?.[1]) return Number(rooms[1]);
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
  // Bez diakritiky, lebo inzeráty píšu "vo výške" aj "vo vyske".
  const joined = texts
    .filter(Boolean)
    .join(' ')
    .replace(/\u00a0/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

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

/** "20.08.2026" -> ISO timestamp o polnoci UTC. */
export function parseSlovakDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!match) return null;

  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
