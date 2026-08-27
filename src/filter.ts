import { COMMISSION_FREE_BONUS, CRITERIA, isCommissionFree } from './config.js';
import { parseEnergies, parseStatedTotal } from './parse.js';
import type { Criteria, Listing, PriceBasis } from './types.js';

/**
 * Tieto slová vážia dvojnásobne – práve kvôli nim inzerát otvoríme ako prvý.
 * Musia doslova sedieť s hodnotami v CRITERIA.positiveKeywords.
 */
const DOUBLE_WEIGHT_KEYWORDS = [
  'novostavba',
  'po kompletnej rekonštrukcii',
  'kompletne zrekonštruovaný',
];

const MAX_SCORE = 10;

/**
 * Porovnávame bez diakritiky a bez veľkých písmen – inzeráty sú písané všelijako
 * ("novostavba", "NOVOSTAVBA", "novostavba" bez mäkčeňov) a inak by nám polovica ušla.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Najkratší koreň, na ktorý sa ešte oplatí porovnávať. */
const MIN_STEM_LENGTH = 4;

/**
 * Slovenčina inzerát skloňuje: "kancelária" sa v texte objaví ako "kancelárie",
 * "pred rekonštrukciou" ako "rekonštrukciou". Doslovné hľadanie by tieto tvary
 * minulo, tak z kľúčového slova odrežeme koncové samohlásky a porovnávame koreň.
 */
function keywordStem(keyword: string): string {
  let stem = normalize(keyword);
  while (stem.length > MIN_STEM_LENGTH && /[aeiouy]$/.test(stem)) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/**
 * Koreň musí začínať na hranici slova, inak by "obsadené" našlo aj "neobsadené"
 * a vyradilo by presne tie voľné byty, ktoré hľadáme.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
  const stem = keywordStem(keyword);

  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(stem, from);
    if (at < 0) return false;
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1] as string)) return true;
    from = at;
  }
}

/* ------------------------------------------------------- dopytové inzeráty */

/** Koľko slov smie stáť medzi slovami frázy – "hľadám do prenájmu 3-izbový byt". */
const DEMAND_GAP = 4;

/** Kratšie slovo než toto musí nasledovať hneď za predchádzajúcim. */
const MIN_GAPPED_WORD = 3;

/**
 * Aj prenajímateľ píše v prvej osobe: "hľadáme nájomníkov, ktorí...". Keď medzi
 * "hľadám" a "byt" stojí nájomca, je to ponuka, nie dopyt, a nesmie vypadnúť.
 */
const TENANT_WORDS = ['nájomca', 'nájomník', 'podnájom'];

/** Text rozsekaný na slová – porovnávame po slovách, nie po znakoch. */
function wordsOf(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * Sedia zvyšné korene frázy, keď prvý sedel na slove `start`? Každý ďalší musí
 * nasledovať v poradí a najviac DEMAND_GAP slov za predchádzajúcim.
 */
function matchesFrom(words: readonly string[], stems: readonly string[], start: number): boolean {
  let at = start;

  for (const stem of stems.slice(1)) {
    // Krátke slovko ("sa") pustené cez medzeru sa prilepí na hocijaké "hľadá"
    // v ponuke, tak ho pýtame hneď za predchádzajúcim slovom.
    const reach = Math.min(stem.length < MIN_GAPPED_WORD ? at + 1 : at + DEMAND_GAP + 1, words.length - 1);

    let found = -1;
    for (let next = at + 1; next <= reach; next += 1) {
      const word = words[next] as string;
      if (TENANT_WORDS.some((tenant) => word.startsWith(keywordStem(tenant)))) return false;
      if (word.startsWith(stem)) {
        found = next;
        break;
      }
    }

    if (found < 0) return false;
    at = found;
  }

  return true;
}

/** Nájde frázu v texte rozsekanom na slová. Korene sa porovnávajú od začiatku slova. */
function containsPhrase(words: readonly string[], phrase: string): boolean {
  const stems = phrase.split(' ').map(keywordStem);
  const first = stems[0] as string;

  // Jediné slovo nemá okolo seba kontext, ktorý by ho ubránil, tak musí sedieť
  // celé: inak "dopytu po nájomnom bývaní" vyhodí úplne normálnu ponuku.
  if (stems.length === 1) return words.includes(normalize(phrase));

  for (let start = 0; start < words.length; start += 1) {
    if (!(words[start] as string).startsWith(first)) continue;
    if (matchesFrom(words, stems, start)) return true;
  }

  return false;
}

/** Dopytová fráza z názvu alebo popisu, alebo null keď inzerát byt ponúka. */
export function demandPhrase(listing: Listing, criteria: Criteria = CRITERIA): string | null {
  const words = wordsOf(listing.title + ' ' + listing.description);
  return criteria.demandKeywords.find((phrase) => containsPhrase(words, phrase)) ?? null;
}

/* ------------------------------------------------------------- základ ceny */

/**
 * Fráza sa hľadá bez diakritiky a po koreňoch, aby sedela aj na skloňované tvary.
 * Slovo kratšie než koreň (predložka "s", "v") musí sedieť presne – inak by "s"
 * chytalo hocijaké slovo na "s" a "s energiami" by našlo aj "služby energií".
 */
/** Suma s menou a prípadným "/mes.", ktorá smie stáť hneď za plusom. */
const AFTER_PLUS = String.raw`\s*(?:\d[\d\s.]*(?:,(?:\d+|-))?\s*(?:€|eur)\s*(?:/\s*mes(?:\.|iac)?)?\s*)?`;

function priceBasisPattern(phrase: string): RegExp {
  const words = normalize(phrase).split(' ');
  let source = '';

  words.forEach((word, index) => {
    if (index > 0 && !source.endsWith(')?')) source += String.raw`\s+`;

    // Za plusom stojí často ešte suma: "+ 200 € energie", "+110 eur/mes energie",
    // "cena 900 plus 300,-€/mesiac energie". Je to tá istá veta, len vypísaná.
    if (word === '+' || word === 'plus') {
      source += (word === '+' ? String.raw`\+` : 'plus') + AFTER_PLUS;
      return;
    }

    source += word.length < MIN_STEM_LENGTH ? word : keywordStem(word) + '[a-z]*';
  });

  // Hranicu slova pýtame len pred písmenom. Plus býva prilepený na predchádzajúce
  // slovo ("1.190 eur/mes+110 eur/mes energie") a hranica by ho minula.
  const boundary = words[0] === '+' ? '' : String.raw`(?<![a-z])`;
  // Globálny, aby sa dali prejsť všetky výskyty – prvý môže stáť v zápore
  // a rozhodovať má až ten, ktorý v ňom nestojí.
  return new RegExp(boundary + source, 'gi');
}

/** Skompilované vzory si držíme – regex sa inak stavia pre každý inzerát nanovo. */
const PATTERN_CACHE = new Map<string, RegExp>();

function patternFor(phrase: string): RegExp {
  let pattern = PATTERN_CACHE.get(phrase);
  if (pattern === undefined) {
    pattern = priceBasisPattern(phrase);
    PATTERN_CACHE.set(phrase, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

/**
 * Holé "bez" nezapiera nič: "bez výťahu", "bez zvierat", "bez provízie" stoja
 * v inzerátoch hneď pred cenou a s energiami nemajú nič spoločné. Zapiera až
 * vtedy, keď za ním stojí to, čo by cena mala kryť.
 */
const NEGATED_BY_BEZ = ['energií', 'energie', 'poplatkov', 'poplatky', 'služieb', 'služby', 'záloh', 'zálohy'];

/**
 * Slová, ktorými inzerát frázu popiera: "cena nájmu nezahŕňa energie",
 * "nájom je bez energií", "všetko okrem energií". Porovnávajú sa po koreňoch,
 * takže "nezahŕňa" sedí aj na "nezahŕňajú"; slovo kratšie než koreň musí sedieť
 * presne, inak by "bez" chytilo aj "bezbariérový".
 */
const NEGATION_CUES = [
  'nezahŕňa',
  'neobsahuje',
  'nie je',
  'okrem',
  'mimo',
  ...NEGATED_BY_BEZ.map((object) => 'bez ' + object),
];

/** Koľko slov pred frázou sa ešte pozeráme po zápore. */
const NEGATION_REACH = 4;

/**
 * Cez koniec vety zápor nesiaha. "Bez zvierat. Cena: 1100 €, vrátane energií"
 * je pokojne cena vrátane energií – to "bez" patrí k celkom inej vete.
 */
const CLAUSE_END = /[.!?;•|\n]/;

/**
 * Sedí zápor, ktorý sa začína v okne pred frázou? Viacslovný ("nie je", "bez
 * energií") musí sedieť v poradí a smie prečnievať do samotnej frázy – "bez
 * energií v cene" má popreté slovo až v nej.
 */
function cueBefore(words: readonly string[], cue: string, until: number): boolean {
  const parts = normalize(cue)
    .split(' ')
    .map((word) => (word.length < MIN_STEM_LENGTH ? word : keywordStem(word)));

  for (let start = Math.max(until - NEGATION_REACH, 0); start < until; start += 1) {
    if (start + parts.length > words.length) break;

    const fits = parts.every((part, offset) => {
      const word = words[start + offset] as string;
      return part.length < MIN_STEM_LENGTH ? word === part : word.startsWith(part);
    });
    if (fits) return true;
  }

  return false;
}

/**
 * Stojí zásah `matched` na pozícii `at` v zápore? "Cena nájmu nezahŕňa energie,
 * v cene 190 eur/mesiac" hovorí presný opak toho, čo fráza "energie v cene"
 * naznačuje.
 */
function isNegated(haystack: string, at: number, matched: string): boolean {
  const before = haystack.slice(0, at);
  const clause = wordsOf(before.slice(lastClauseStart(before)));

  // Slová frázy pripájame, aby zápor mohol siahnuť aj na jej prvé slovo.
  const words = [...clause, ...wordsOf(matched)];
  return NEGATION_CUES.some((cue) => cueBefore(words, cue, clause.length));
}

/** Za posledným koncom vety – tam začína veta, v ktorej fráza naozaj stojí. */
function lastClauseStart(text: string): number {
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (CLAUSE_END.test(text[at] as string)) return at + 1;
  }
  return 0;
}

/** Sedí niektorá z fráz? Zápor sa tu nerieši, len holý zásah. */
function matchesAny(haystack: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    const pattern = patternFor(phrase);
    if (pattern.exec(haystack) !== null) return true;
  }
  return false;
}

/** Zásah bez záporu / len popretý zásah / nič. */
type PhraseHit = 'clear' | 'negated' | 'none';

/**
 * Prejde všetky výskyty, nie len prvý – jedna popretá veta nesmie umlčať poctivú
 * vetu o kus nižšie. Keď zostanú samé popreté zásahy, je to samo osebe odpoveď:
 * inzerát hovorí, že energie v cene nie sú.
 */
function findPhrase(haystack: string, phrases: readonly string[]): PhraseHit {
  let negated = false;

  for (const phrase of phrases) {
    const pattern = patternFor(phrase);

    for (let hit = pattern.exec(haystack); hit !== null; hit = pattern.exec(haystack)) {
      if (!isNegated(haystack, hit.index, hit[0])) return 'clear';
      negated = true;
    }
  }

  return negated ? 'negated' : 'none';
}

/**
 * Čo už uvedená cena kryje. Keď si inzerát protirečí – a stáva sa to, býva v ňom
 * cena bez energií aj s nimi – platí `rent_only`: v hlavičke visí tá nižšia.
 * Popretá fráza o energiách v cene hovorí presný opak, tak sa neráta vôbec.
 */
export function detectPriceBasis(listing: Listing, criteria: Criteria = CRITERIA): PriceBasis {
  const haystack = normalize(listing.title + ' ' + listing.description);

  if (matchesAny(haystack, criteria.rentOnlyKeywords)) return 'rent_only';

  const allIn = findPhrase(haystack, criteria.allInKeywords);
  if (allIn === 'clear') return 'all_in';
  return allIn === 'negated' ? 'rent_only' : 'unknown';
}

/**
 * Odhad energií podľa plochy, orezaný do rozsahu z CRITERIA. Keď plochu nepoznáme,
 * berieme spodnú hranicu – vyššie číslo by inzerát vyradilo na základe výmyslu.
 */
export function estimateEnergies(listing: Listing, criteria: Criteria = CRITERIA): number {
  const raw =
    listing.areaSqm === null
      ? criteria.minEstimatedEnergiesEur
      : Math.round(listing.areaSqm * criteria.energiesPerSqmEur);

  return Math.min(Math.max(raw, criteria.minEstimatedEnergiesEur), criteria.maxEstimatedEnergiesEur);
}

/**
 * Koľkonásobok ceny z karty ešte smie byť suma z textu. Vyššie číslo už nie je
 * mesačná cena spolu, ale cena predaja alebo nájom za celý rok.
 */
const MAX_STATED_TOTAL_RATIO = 3;

/**
 * Cena spolu z popisu, keď je vyššia než cena z karty a zmestí sa do násobku.
 * Nižšia suma sa neberie: pod cenu z hlavičky sa inzerát nikdy nedostane a
 * číslo pod ňou býva zálohy, nie cena spolu.
 */
function statedTotal(listing: Listing): number | null {
  const price = listing.priceEur;
  if (price === null || price === 0) return null;

  const stated = parseStatedTotal(listing.description, listing.title);
  if (stated === null) return null;

  return stated > price && stated <= price * MAX_STATED_TOTAL_RATIO ? stated : null;
}

/**
 * Určí základ ceny, doplní energie a dopočíta totalPriceEur tak, aby vždy platilo
 * totalPriceEur = priceEur + energiesEur. `estimatedEnergies` je true len vtedy,
 * keď sa energie naozaj odhadovali.
 */
export function withTotalPrice(listing: Listing, criteria: Criteria = CRITERIA): Listing {
  // Odhadnúť sa smú len energie, nájom nikdy. Nula znamená to isté čo chýbajúci
  // údaj – inzerát bez nájmu nemá k čomu energie pripočítať.
  if (listing.priceEur === null || listing.priceEur === 0) {
    return { ...listing, priceBasis: detectPriceBasis(listing, criteria), totalPriceEur: null };
  }

  const priceBasis = detectPriceBasis(listing, criteria);

  // Popis vie povedať vyššiu cenu spolu, než akú má inzerát v hlavičke (karta
  // 1 090 €, text „vrátane energií je 1450€"). Vtedy platí text – hlavička býva
  // lákadlo alebo neaktualizovaná – a to aj proti all_in, ktoré by inak nechalo
  // stáť tú nižšiu sumu.
  const total = statedTotal(listing);
  if (total !== null) {
    return {
      ...listing,
      priceBasis,
      energiesEur: total - listing.priceEur,
      totalPriceEur: total,
      estimatedEnergies: false,
    };
  }

  // Cena už kryje energie, takže sa k nej nič nepripočítava.
  if (priceBasis === 'all_in') {
    return {
      ...listing,
      priceBasis,
      energiesEur: 0,
      totalPriceEur: listing.priceEur,
      estimatedEnergies: false,
    };
  }

  // Neznámy základ berieme ako nájom bez energií – radšej prísť o inzerát než
  // dostať taký, ktorý je po pripočítaní energií nad stropom.
  // Nula znamená "nič sa nenašlo", nie "energie sú zadarmo", tak sa dohľadáva ďalej.
  const known = listing.energiesEur === null || listing.energiesEur === 0 ? null : listing.energiesEur;
  const stated = known ?? parseEnergies(listing.description, listing.title);
  const energies = stated ?? estimateEnergies(listing, criteria);

  return {
    ...listing,
    priceBasis,
    energiesEur: energies,
    totalPriceEur: listing.priceEur + energies,
    estimatedEnergies: stated === null,
  };
}

/**
 * Skóre 0–10: koľko kladných kľúčových slov sedí v názve a popise.
 * Novostavba a kompletná rekonštrukcia sa rátajú dvakrát.
 */
export function scoreListing(listing: Listing, criteria: Criteria = CRITERIA): number {
  const haystack = normalize(listing.title + ' ' + listing.description);

  let score = 0;
  for (const keyword of criteria.positiveKeywords) {
    if (!containsKeyword(haystack, keyword)) continue;
    score += DOUBLE_WEIGHT_KEYWORDS.includes(keyword) ? 2 : 1;
  }

  // Inzerát priamo od majiteľa ušetrí nájomcovi províziu vo výške mesačného nájmu.
  if (isCommissionFree(listing)) score += COMMISSION_FREE_BONUS;

  return Math.min(score, MAX_SCORE);
}

/**
 * Ktoré pravidlo inzerát vyhodilo. Dopyt a chýbajúcu cenu rátame osobitne –
 * v reporte je po behu vidieť, koľko toho každé z nich zobralo.
 */
export type RejectionRule = 'demand' | 'noPrice' | 'other';

export interface Rejection {
  rule: RejectionRule;
  reason: string;
}

/** Dôvod vyradenia aj s pravidlom, alebo null keď inzerát prejde. */
function rejection(listing: Listing, criteria: Criteria): Rejection | null {
  // Dopytový inzerát byt nikdy neponúka, takže čísla v ňom nemá zmysel ani čítať.
  const demand = demandPhrase(listing, criteria);
  if (demand !== null) return { rule: 'demand', reason: 'dopyt: ' + demand };

  // Bez nájmu inzerát nevyhodnotíme – a nájom sa neodhaduje, len energie.
  if (listing.priceEur === null || listing.priceEur === 0) {
    return { rule: 'noPrice', reason: 'bez ceny nájmu' };
  }

  const other = otherRejection(listing, criteria);
  return other === null ? null : { rule: 'other', reason: other };
}

/** Dôvod vyradenia, alebo null keď inzerát prejde. */
export function rejectionReason(listing: Listing, criteria: Criteria = CRITERIA): string | null {
  return rejection(listing, criteria)?.reason ?? null;
}

/** Pôvodné kritériá: izby, plocha, cena a záporné slová. */
function otherRejection(listing: Listing, criteria: Criteria): string | null {
  // Neznámy údaj inzerát nevyraďuje – radšej ho ukážeme, než by nám ušiel kvôli
  // chýbajúcemu číslu vo výpise.
  if (listing.rooms !== null && listing.rooms < criteria.minRooms) {
    return 'málo izieb (' + listing.rooms + ')';
  }
  if (listing.areaSqm !== null && listing.areaSqm < criteria.minAreaSqm) {
    return 'malá plocha (' + listing.areaSqm + ' m2)';
  }
  if (listing.totalPriceEur !== null && listing.totalPriceEur > criteria.maxTotalPriceEur) {
    return 'drahé (' + listing.totalPriceEur + ' EUR)';
  }

  const haystack = normalize(listing.title + ' ' + listing.description);
  for (const keyword of criteria.negativeKeywords) {
    if (containsKeyword(haystack, keyword)) return 'zaporne slovo: ' + keyword;
  }

  return null;
}

export interface FilterResult {
  /** Inzeráty, ktoré prešli, zoradené od najlepšieho. */
  kept: Listing[];
  /** Koľko inzerátov vyhodilo pravidlo o dopytových inzerátoch. */
  demand: number;
  /** Koľko inzerátov vyhodilo pravidlo o chýbajúcom nájme. */
  noPrice: number;
  /** Ako sa rozdelil základ ceny medzi inzerátmi, ktoré sa vôbec dostali k počítaniu. */
  basis: Record<PriceBasis, number>;
}

/**
 * Vyhodí inzeráty, ktoré nespĺňajú kritériá, zvyšku dopočíta cenu s energiami
 * a skóre. Zoradené od najvyššieho skóre, pri zhode od najlacnejšieho.
 *
 * Inzerát sa ráta tomu pravidlu, ktoré ho vyhodilo ako prvé – dopyt bez ceny
 * teda pribudne k dopytom, nie k obom počtom naraz.
 */
export function filterListings(listings: readonly Listing[], criteria: Criteria = CRITERIA): FilterResult {
  const kept: Listing[] = [];
  const basis: Record<PriceBasis, number> = { all_in: 0, rent_only: 0, unknown: 0 };
  let demand = 0;
  let noPrice = 0;

  for (const listing of listings) {
    const priced = withTotalPrice(listing, criteria);
    const bad = rejection(priced, criteria);

    if (bad !== null) {
      if (bad.rule === 'demand') demand += 1;
      else if (bad.rule === 'noPrice') noPrice += 1;
      // Základ ceny rátame len tam, kde sa naozaj počítalo s číslami.
      else basis[priced.priceBasis] += 1;
      continue;
    }

    basis[priced.priceBasis] += 1;
    kept.push({ ...priced, score: scoreListing(priced, criteria) });
  }

  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.totalPriceEur ?? Infinity) - (b.totalPriceEur ?? Infinity);
  });

  return { kept, demand, noPrice, basis };
}
