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

  /** Odhad energií, keď inzerát uvádza iba nájom "bez energií". */
  estimatedEnergiesEur: 150,

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
  ],
};
