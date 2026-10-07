/** What the map says, in Slovak and English (UI-30): the reader's language, else Slovak. */
import type { Kind } from "./places";

export interface Strings {
  locale: string;
  title: string;
  subtitle: string;
  search: string;
  searchHelp: string;
  show: string;
  kind: Record<Kind, string>;
  results: (count: number) => string;
  noResults: string;
  loading: string;
  noEndpoint: string;
  refused: (kind: string, reason: string) => string;
  truncated: (kind: string, count: number) => string;
  mapLabel: string;
  noBasemap: string;
  notOnMap: string;
  close: string;
  detailOf: (name: string) => string;
  unnamed: string;
  address: string;
  district: string;
  website: string;
  category: Record<Kind, string>;
  values: Record<string, string>;
  operator: string;
  specialties: string;
  serviceKind: string;
  targetGroup: string;
  capacity: string;
  provider: string;
  noValue: string;
  attribution: string;
}

const sk: Strings = {
  locale: "sk",
  title: "Mapa Banskobystrického kraja",
  subtitle: "Nemocnice, sociálne služby a organizácie kraja z jeho verejných registrov, na jednej mape.",
  search: "Hľadať podľa názvu, adresy alebo okresu",
  searchHelp: "Hľadá aj bez diakritiky, napríklad „socialne“.",
  show: "Zobraziť na mape",
  kind: { hospital: "Nemocnice", social: "Sociálne služby", organization: "Organizácie kraja" },
  results: (count) => `${count} ${count === 1 ? "miesto" : count >= 2 && count <= 4 ? "miesta" : "miest"}`,
  noResults: "Nič sa nenašlo. Skúste iné slovo alebo zapnite ďalšiu vrstvu.",
  loading: "Načítavam miesta…",
  noEndpoint: "Aplikácia nemá zverejnený prístup k verejným registrom kraja, preto nemá čo zobraziť.",
  refused: (kind, reason) => `${kind} sa nepodarilo načítať: ${reason}`,
  truncated: (kind, count) => `${kind}: zobrazených je prvých ${count}; spresnite hľadanie.`,
  mapLabel: "Mapa miest; rovnaké miesta sú v zozname vedľa mapy",
  noBasemap: "Podkladová mapa nie je nastavená, miesta sú zobrazené na prázdnom pozadí.",
  notOnMap: "bez polohy, iba v zozname",
  close: "Zavrieť",
  detailOf: (name) => `Detail: ${name}`,
  unnamed: "Bez názvu",
  address: "Adresa",
  district: "Okres",
  website: "Webová stránka",
  category: { hospital: "Druh nemocnice", social: "Forma služby", organization: "Oblasť" },
  values: {
    general: "všeobecná nemocnica",
    specialised: "špecializovaná nemocnica",
    field: "terénna",
    outpatient: "ambulantná",
    residentialYearRound: "pobytová, celoročná",
    residentialWeekly: "pobytová, týždenná",
    remote: "na diaľku",
    school: "školstvo",
    socialCare: "sociálna starostlivosť",
    culture: "kultúra",
    office: "úrad",
    municipality: "obec alebo mesto",
    municipalityFounded: "založená obcou alebo mestom",
    regionFounded: "založená krajom",
  },
  operator: "Prevádzkovateľ",
  specialties: "Odbornosti",
  serviceKind: "Druh služby",
  targetGroup: "Pre koho",
  capacity: "Kapacita (miest)",
  provider: "Poskytovateľ",
  noValue: "neuvedené",
  attribution:
    "Zdroj: Banskobystrický samosprávny kraj — zoznam zdravotníckych zariadení (nemocnice), zoznam verejných poskytovateľov sociálnych služieb a organizácie v jeho zriaďovateľskej pôsobnosti; cez verejný priestor bbsk-registre.",
};

const en: Strings = {
  locale: "en",
  title: "Map of the Banská Bystrica region",
  subtitle: "Hospitals, social services and the region's organizations from its public registers, on one map.",
  search: "Search by name, address or district",
  searchHelp: "Finds words without diacritics too, for example “socialne”.",
  show: "Show on the map",
  kind: { hospital: "Hospitals", social: "Social services", organization: "Organizations of the region" },
  results: (count) => `${count} ${count === 1 ? "place" : "places"}`,
  noResults: "Nothing found. Try another word or turn on another layer.",
  loading: "Loading places…",
  noEndpoint: "This app has no published access to the region's public registers, so it has nothing to show.",
  refused: (kind, reason) => `${kind} could not be loaded: ${reason}`,
  truncated: (kind, count) => `${kind}: the first ${count} are shown; narrow the search.`,
  mapLabel: "Map of the places; the same places are in the list beside the map",
  noBasemap: "No base map is configured, so the places are drawn on a plain background.",
  notOnMap: "no position, in the list only",
  close: "Close",
  detailOf: (name) => `Details: ${name}`,
  unnamed: "Unnamed",
  address: "Address",
  district: "District",
  website: "Website",
  category: { hospital: "Kind of hospital", social: "Form of service", organization: "Area" },
  values: {
    general: "general hospital",
    specialised: "specialised hospital",
    field: "where the person lives",
    outpatient: "the person comes to it",
    residentialYearRound: "residential, all year",
    residentialWeekly: "residential, weekly",
    remote: "remote",
    school: "education",
    socialCare: "social care",
    culture: "culture",
    office: "office",
    municipality: "a municipality or town",
    municipalityFounded: "founded by a municipality or town",
    regionFounded: "founded by the region",
  },
  operator: "Operator",
  specialties: "Specialties",
  serviceKind: "Kind of service",
  targetGroup: "For whom",
  capacity: "Capacity (places)",
  provider: "Provider",
  noValue: "not given",
  attribution:
    "Source: Banská Bystrica Self-Governing Region — its list of health-care facilities (hospitals), of public social-service providers and of the organizations it founded; through the public space bbsk-registre.",
};

export const LOCALES: Record<string, Strings> = { sk, en };

export function stringsFor(language: string | undefined): Strings {
  const short = (language ?? "sk").slice(0, 2).toLowerCase();
  return LOCALES[short] ?? sk;
}
