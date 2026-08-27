/**
 * Čo už je v uvedenej cene. `all_in` = energie a poplatky sú v nej zahrnuté,
 * `rent_only` = platia sa navyše, `unknown` = inzerát to nehovorí. Neznámy základ
 * rátame ako `rent_only` – radšej prísť o inzerát než dostať taký, čo je nad strop.
 */
export type PriceBasis = 'all_in' | 'rent_only' | 'unknown';

/** Jeden inzerát prenájmu, normalizovaný do spoločného tvaru naprieč zdrojmi. */
export interface Listing {
  /** Stabilný identifikátor, napr. "zoznamrealit:123456". */
  id: string;
  /** Názov zdrojového modulu, ktorý inzerát načítal. */
  source: string;
  title: string;
  url: string;
  /** Nájom bez energií v EUR / mesiac. `null` ak sa nepodarilo zistiť. */
  priceEur: number | null;
  /** Energie a poplatky v EUR / mesiac. `null` ak ich inzerát neuvádza. */
  energiesEur: number | null;
  /** priceEur + energiesEur (alebo odhad) – číslo porovnávané s maxTotalPriceEur. */
  totalPriceEur: number | null;
  /** Či uvedená cena už kryje energie. Dopočíta filter z názvu a popisu. */
  priceBasis: PriceBasis;
  /** True ak energie v inzeráte neboli a použil sa CRITERIA.estimatedEnergiesEur. */
  estimatedEnergies: boolean;
  areaSqm: number | null;
  rooms: number | null;
  /** Okres / mestská časť, napr. "Bratislava III". */
  locality: string | null;
  street: string | null;
  description: string;
  imageUrl: string | null;
  /** ISO 8601 timestamp zverejnenia, ak ho zdroj poskytuje. */
  publishedAt: string | null;
  /**
   * Inzerát podal majiteľ, nie realitka, takže nájomcu nečaká provízia. Dopočíta
   * filter zo zdroja a textu inzerátu; zhodiť ho môže ešte dedup, keď sa ten istý
   * byt nájde aj na realitnom portáli. Zdroje sem píšu `false`.
   */
  commissionFree: boolean;
  /**
   * Ten istý inzerát v iných zdrojoch, zlúčený dedupom. Zdroje sem píšu prázdne
   * pole, plní ho až `collapseDuplicates`.
   */
  mirrors: Mirror[];
  /** Skóre z filtra – čím vyššie, tým lepšia zhoda s kritériami. */
  score: number;
}

/** Odkaz na ten istý inzerát v inom zdroji. */
export interface Mirror {
  source: string;
  url: string;
}

/** Kritériá vyhľadávania. Konkrétne hodnoty sú v `src/config.ts`. */
export interface Criteria {
  minRooms: number;
  maxTotalPriceEur: number;
  minAreaSqm: number;
  /** Odhad energií na m² za mesiac, keď inzerát sumu neuvádza. */
  energiesPerSqmEur: number;
  /** Spodná a horná hranica toho odhadu. */
  minEstimatedEnergiesEur: number;
  maxEstimatedEnergiesEur: number;
  localities: readonly string[];
  positiveKeywords: readonly string[];
  negativeKeywords: readonly string[];
  /** Frázy, ktorými sa prezradí dopytový inzerát – realitka byt hľadá, neponúka. */
  demandKeywords: readonly string[];
  /** Frázy, ktorými sa inzerát hlási k realitke – vtedy sa provízia platí. */
  agencyKeywords: readonly string[];
  /** Slová, ktorými inzerát výraz o realitke popiera („bez provízie"). */
  agencyNegations: readonly string[];
  /** Frázy, po ktorých je uvedená cena už vrátane energií. */
  allInKeywords: readonly string[];
  /** Frázy, po ktorých sa energie platia navyše. Pri spore vyhrávajú nad allInKeywords. */
  rentOnlyKeywords: readonly string[];
}

/** Podpis, ktorý musí spĺňať každý modul v `src/sources/`. */
export type FetchListings = (criteria: Criteria) => Promise<Listing[]>;

export interface Source {
  name: string;
  fetchListings: FetchListings;
}
