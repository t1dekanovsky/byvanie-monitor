import type { Criteria } from './types.js';

/**
 * Zdroje, kde inzerát podáva priamo majiteľ, nie realitka. Nájomcu tam nečaká
 * provízia vo výške mesačného nájmu, čo je pri strope 1 200 € rozdiel väčší než
 * ktorékoľvek kľúčové slovo – preto za to inzerát dostáva bonus k skóre a v Slacku
 * to vidno na prvý pohľad.
 *
 * Samotný zdroj ale nestačí: na Bazoš preposielajú ponuky aj realitky. Bonus preto
 * dostane len inzerát, ktorý (a) nevisí zároveň na realitnom portáli – to rieši
 * dedup v `src/index.ts` – a (b) sa k realitke nehlási ani vo vlastnom texte, čo
 * rieši `AGENCY_KEYWORDS` nižšie.
 */
const COMMISSION_FREE_SOURCES: readonly string[] = ['bazos'];

/** Bonus k skóre za inzerát bez provízie. */
export const COMMISSION_FREE_BONUS = 2;

export function isCommissionFreeSource(source: string): boolean {
  return COMMISSION_FREE_SOURCES.includes(source);
}


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
    // „s energiami" stojí aj vo vete o depozite či provízii, ale poctivých
    // zásahov má neporovnateľne viac a nič iné ich nekryje. Byty, ktoré cez ňu
    // predtým prechádzali nad strop, dnes zastaví cena spolu vyčítaná z popisu.
    's energiami',
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

  /**
   * Podľa čoho spoznať realitku v texte inzerátu. Porovnáva sa po slovách a po
   * koreňoch, takže „realitná kancelária" sedí aj na „realitnej kancelárie";
   * dvojpísmenkové „RK" musí sedieť celým slovom.
   *
   * Sú to zámerne kmene, nie celé súslovia: „sprostredkovateľ" pokryje aj
   * „sprostredkovateľský poplatok" a skloňovanie, ktoré by dvojslovnú frázu minulo.
   */
  agencyKeywords: [
    'realitná kancelária',
    'realitka',
    'RK',
    'provízia',
    'sprostredkovateľ',
    'maklér',
    'v zastúpení',
  ],

  /**
   * Slová, ktorými inzerát výraz o realitke popiera. Majiteľ píše „bez provízie",
   * „RK prosím nevolať" či „realitné kancelárie nekontaktovať" – to je opak realitky
   * a práve taký inzerát chceme mať navrchu. Hľadajú sa v okolí nájdeného výrazu.
   */
  agencyNegations: [
    'bez',
    'žiadna',
    'nie',
    // Zámerne v najkratšom tvare, aby koreň pokryl celé sloveso: „neplatí",
    // „neplatíte" aj „neplatia". Dlhší tvar by sedel len na jednu osobu.
    'neplatí',
    'neúčtuje',
    'nevolá',
    'nekontakt',
    'neposiela',
    'nežiada',
    'nemám',
    'neponúka',
    'nulová',
    'vylúčené',
    'odmieta',
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

    /**
     * Bazoš. Súkromník tam v tej istej kategórii ponúka aj izbu v byte alebo
     * lôžko pre partiu robotníkov – čísla sedia (izby a plocha sú za celý byt),
     * ale prenajíma sa kus. Frázy sú zámerne dlhé: samotné „izbu" stojí v popise
     * poctivých ponúk („dve samostatné izby") a vyradilo by ich tiež.
     */
    'prenajmem izbu',
    'prenájom izby',
    'izba na prenájom',
    'spolubývajúci',
    'cena za osobu',
    'za lôžko',
    'pre robotníkov',
    'pre pracujúcich',
    'pre partiu',
    'ubytovňa',
    'ubytovanie pre',
  ],
};
