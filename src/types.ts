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
  /** Skóre z filtra – čím vyššie, tým lepšia zhoda s kritériami. */
  score: number;
}

/** Kritériá vyhľadávania. Konkrétne hodnoty sú v `src/config.ts`. */
export interface Criteria {
  minRooms: number;
  maxTotalPriceEur: number;
  minAreaSqm: number;
  /** Použije sa, keď inzerát uvádza iba nájom bez energií. */
  estimatedEnergiesEur: number;
  localities: readonly string[];
  positiveKeywords: readonly string[];
  negativeKeywords: readonly string[];
}

/** Podpis, ktorý musí spĺňať každý modul v `src/sources/`. */
export type FetchListings = (criteria: Criteria) => Promise<Listing[]>;

export interface Source {
  name: string;
  fetchListings: FetchListings;
}
