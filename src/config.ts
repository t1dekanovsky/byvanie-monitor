import type { Criteria } from './types.js';

/**
 * Kritériá hľadania. Jediné miesto, kde sa ladí, čo sa považuje za zhodu –
 * zdroje aj filter berú hodnoty odtiaľto, nikde inde nie sú natvrdo zapísané.
 */
export const CRITERIA: Criteria = {
  /** Minimálny počet izieb (3 = 3-izbový byt a väčší). */
  minRooms: 3,

  /** Strop na nájom + energie spolu, EUR / mesiac. */
  maxTotalPriceEur: 1200,

  /** Minimálna úžitková plocha v m². */
  minAreaSqm: 60,

  /**
   * Odhad energií, keď inzerát sumu neuvádza: plocha × sadzba, orezané do rozsahu.
   * Malá garsónka a 200 m² vila nestoja na energiách rovnako, plochý odhad 150 €
   * púšťal veľké byty hlboko pod ich skutočnú cenu.
   */
  energiesPerSqmEur: 2.5,
  minEstimatedEnergiesEur: 150,
  maxEstimatedEnergiesEur: 350,

  /** Celý Bratislavský kraj. */
  localities: [
    'Bratislava I',
    'Bratislava II',
    'Bratislava III',
    'Bratislava IV',
    'Bratislava V',
    'Malacky',
    'Pezinok',
    'Senec',
  ],

  /**
   * Uvedená cena už kryje energie. Porovnáva sa bez diakritiky a po koreňoch,
   * takže "vrátane energií" sedí aj na "vrátane energie".
   */
  allInKeywords: [
    'vrátane energií',
    // „s energiami" tu zámerne nie je: rovnako často stojí vo vete o depozite
    // („depozit vo výške mesačného nájmu s energiami") alebo o provízii, takže
    // o základe ceny rozhodovala aj tam, kde o cene vôbec nešlo.
    'energie v cene',
    'všetko v cene',
    'vrátane všetkých poplatkov',
    'vrátane poplatkov',
    'cena je konečná',
    'all inclusive',
    'vrátane služieb',
  ],

  /**
   * Energie sa platia navyše. Pri spore s allInKeywords vyhrávajú tieto – inzerát
   * často uvedie obe ceny ("850 € + energie, alebo 1 050 € vrátane energií") a
   * v hlavičke visí tá nižšia, teda nájom bez energií.
   */
  rentOnlyKeywords: [
    '+ energie',
    'plus energie',
    'bez energií',
    'energie zvlášť',
    'energie osobitne',
    '+ zálohy',
    '+ poplatky',
    '+ služby',
    'k tomu energie',
    'energie podľa spotreby',
    'energie sa platia zvlášť',
  ],

  /** Zvyšujú skóre inzerátu. */
  positiveKeywords: [
    'novostavba',
    'po kompletnej rekonštrukcii',
    'kompletne zrekonštruovaný',
    'nový byt',
    'neobývaný',
    'kolaudácia',
    'klimatizácia',
    'podlahové kúrenie',
    'tichá lokalita',
    'samostatný vchod',
    'terasa',
    'záhrada',
    'parkovacie miesto',
    'bez provízie',
  ],

  /**
   * Dopytové inzeráty: realitka byt hľadá pre klienta, neponúka ho. Porovnáva sa
   * bez diakritiky a po koreňoch, takže "hľadám byt" sedí aj na "hľadáme 3-izbový byt".
   * Jednoslovné frázy musia sedieť celým slovom – "dopytu po nájomnom bývaní" je
   * bežná veta v ponuke, nie dopyt.
   */
  demandKeywords: [
    'hľadám byt',
    'hľadáme byt',
    'hľadám dom',
    'hľadáme dom',
    'hľadám pre klienta',
    'hľadáme pre klienta',
    'pre klienta hľadám',
    'pre nášho klienta',
    'dopyt',
    'hľadá sa',
    'sháním',
    'poptávka',
  ],

  /** Vyraďujú inzerát, aj keď čísla sedia. */
  negativeKeywords: [
    'pôvodný stav',
    'čiastočná rekonštrukcia',
    'pred rekonštrukciou',
    'na rekonštrukciu',
    'spolubývanie',
    'krátkodobý prenájom',
    'kancelária',
    'garsónka',

    // Inzerát je už neaktuálny – realitky ich nechávajú visieť s prefixom v názve.
    'prenajaté',
    'prenajate',
    'rezervované',
    'rezervovane',
    'zálohované',
    'zalohovane',
    'obsadené',
    'obsadene',
  ],
};
