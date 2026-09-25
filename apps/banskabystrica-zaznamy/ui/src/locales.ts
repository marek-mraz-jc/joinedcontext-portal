/**
 * Every word on screen, Slovak first (T-2436, T-2437).
 *
 * The same bundle serves the city's records and the region's: which body it is comes from the
 * space the served configuration names, never from a build flag, so one screen cannot be
 * published under the other body's heading. The two locales have the same keys, which
 * `locales.test.ts` asserts.
 */
import type { GridLabels } from "@joinedcontext/sdk";
import { NOTE } from "./records";

/** The raw space of each publisher (`Development/10` §2). */
export const SPACE_OF = {
  banskabystrica: "banskabystrica-mesto",
  bbsk: "bbsk-kraj",
} as const;

export type Body = keyof typeof SPACE_OF;

/** Which publisher's records these are, from the space the configuration names. */
export function bodyOf(space: string | undefined): Body | null {
  const found = (Object.keys(SPACE_OF) as Body[]).find((body) => SPACE_OF[body] === space);
  return found ?? null;
}

export interface Strings {
  locale: string;
  title: Record<Body, string>;
  subtitle: Record<Body, string>;
  /** Why every figure on the screen is read-only. It is the screen's sentence, not a comment. */
  readOnlyWhy: string;
  /** What the one open column is for. */
  noteWhy: string;
  column: Record<string, string>;
  noteFault: {
    tooLong: string;
    forbidden: string;
    notText: string;
  };
  loading: string;
  noEndpoint: string;
  unknownSpace: string;
  source: Record<Body, string>;
  grid: Partial<GridLabels>;
}

const SK: Strings = {
  locale: "sk-SK",
  title: {
    banskabystrica: "Záznamy mesta Banská Bystrica",
    bbsk: "Záznamy Banskobystrického kraja",
  },
  subtitle: {
    banskabystrica:
      "Zverejnené štatistické riadky mesta, po stranách, s filtrom v každom stĺpci. Poznámku správcu môžete upraviť priamo v tabuľke.",
    bbsk: "Zverejnené štatistické riadky kraja, po stranách, s filtrom v každom stĺpci. Poznámku správcu môžete upraviť priamo v tabuľke.",
  },
  readOnlyWhy:
    "Čísla v tabuľke patria vydavateľovi a zapisuje ich kanál: najbližší beh by prepísal čokoľvek, čo by tu niekto prepísal. Preto sa dajú upraviť iba poznámky správcu, nie hodnoty.",
  noteWhy:
    "Poznámka správcu je jediný atribút, ktorý žiadny kanál nezapisuje: sem patrí, čo ste overili a čo vyzerá nesprávne.",
  column: {
    indicator: "Ukazovateľ",
    refArea: "Územie",
    refPeriod: "Obdobie",
    value: "Hodnota",
    dateObserved: "Zistené",
    [NOTE]: "Poznámka správcu",
  },
  noteFault: {
    tooLong: "Poznámka má najviac {max} znakov.",
    forbidden: "Poznámka nesmie obsahovať znaky < a >.",
    notText: "Touto aplikáciou sa dá zapísať iba poznámka správcu, a to ako text.",
  },
  loading: "Načítavajú sa záznamy…",
  noEndpoint: "Aplikácia nemá nastavený endpoint, cez ktorý by čítala.",
  unknownSpace:
    "Aplikácia je nastavená na priestor, ktorý nepozná, preto nevie, koho záznamy by zobrazovala.",
  source: {
    banskabystrica: "Zdroj: mesto Banská Bystrica, priestor banskabystrica-mesto.",
    bbsk: "Zdroj: Banskobystrický samosprávny kraj, priestor bbsk-kraj.",
  },
  grid: {
    id: "Identifikátor",
    type: "Typ",
    observedAt: "Merané",
    unit: "Jednotka",
    datasetId: "Súbor údajov",
    createdAt: "Vytvorené",
    modifiedAt: "Zmenené",
    empty: "Žiadne záznamy.",
    loading: "Načítava sa…",
    previous: "Predchádzajúca strana",
    next: "Ďalšia strana",
    page: "Strana",
    showMetadata: "Zobraziť podrobnosti stĺpca",
    error: "Chyba",
    filter: "Filter",
    ops: {
      contains: "obsahuje",
      equals: "sa rovná",
      notEquals: "sa nerovná",
      gt: ">",
      gte: "≥",
      lt: "<",
      lte: "≤",
      between: "medzi",
      empty: "je prázdne",
      present: "má hodnotu",
      pattern: "zodpovedá",
      anyOf: "je jednou z",
    },
    value: "Hodnota",
    upperValue: "Horná hodnota",
    query: "Dopyt, ktorý sa odošle endpointu",
    copyQuery: "Kopírovať dopyt",
    editAsText: "Upraviť ako text",
    filterRow: "Filtre",
    sortPage: "Zoradiť túto stranu podľa",
    matching: "zodpovedá",
    history: "História",
    edit: "Upraviť",
    pending: "zatiaľ neuložené",
    review: "Skontrolovať zmeny",
    apply: "Uložiť",
    discard: "Zahodiť zmeny",
    attribute: "Atribút",
    before: "Pred zmenou",
    after: "Po zmene",
    observedKeep: "ponechať, kedy bola hodnota zistená",
    observedNow: "tieto hodnoty boli zistené teraz",
    applying: "Ukladá sa…",
    refusedHere: "zamietnuté",
    notInList: "nie je v zozname",
  },
};

const EN: Strings = {
  locale: "en-GB",
  title: {
    banskabystrica: "Records of the city of Banská Bystrica",
    bbsk: "Records of the Banská Bystrica region",
  },
  subtitle: {
    banskabystrica:
      "The city's published statistical rows, by the page, with a filter on every column. The steward's note is edited in the table itself.",
    bbsk: "The region's published statistical rows, by the page, with a filter on every column. The steward's note is edited in the table itself.",
  },
  readOnlyWhy:
    "The figures belong to the publisher and are written by a pipeline: its next run would overwrite anything typed over them here. So the steward's note is what can be edited, and the numbers cannot.",
  noteWhy:
    "The steward's note is the one attribute no pipeline writes: what you checked and what looks wrong belongs in it.",
  column: {
    indicator: "Indicator",
    refArea: "Territory",
    refPeriod: "Period",
    value: "Value",
    dateObserved: "Observed",
    [NOTE]: "Steward's note",
  },
  noteFault: {
    tooLong: "A note holds at most {max} characters.",
    forbidden: "A note may not contain the characters < and >.",
    notText: "This application writes the steward's note and nothing else, and it writes it as text.",
  },
  loading: "Loading the records…",
  noEndpoint: "This application has no endpoint configured to read through.",
  unknownSpace:
    "This application is configured for a space it does not know, so it cannot say whose records it would be showing.",
  source: {
    banskabystrica: "Source: city of Banská Bystrica, space banskabystrica-mesto.",
    bbsk: "Source: Banská Bystrica self-governing region, space bbsk-kraj.",
  },
  grid: {
    id: "Identifier",
    type: "Type",
    observedAt: "Observed",
    unit: "Unit",
    datasetId: "Dataset",
    createdAt: "Created",
    modifiedAt: "Modified",
    empty: "No records.",
    loading: "Loading…",
    previous: "Previous page",
    next: "Next page",
    page: "Page",
    showMetadata: "Show the column's details",
    error: "Error",
    filter: "Filter",
    ops: {
      contains: "contains",
      equals: "is",
      notEquals: "is not",
      gt: ">",
      gte: "≥",
      lt: "<",
      lte: "≤",
      between: "between",
      empty: "is empty",
      present: "has a value",
      pattern: "matches",
      anyOf: "is one of",
    },
    value: "Value",
    upperValue: "Upper value",
    query: "The query this sends to the endpoint",
    copyQuery: "Copy the query",
    editAsText: "Edit as text",
    filterRow: "Filters",
    sortPage: "Sort this page by",
    matching: "matching",
    history: "History",
    edit: "Edit",
    pending: "not saved yet",
    review: "Review the changes",
    apply: "Save",
    discard: "Discard the changes",
    attribute: "Attribute",
    before: "Before",
    after: "After",
    observedKeep: "keep when each value was observed",
    observedNow: "these values were observed now",
    applying: "Saving…",
    refusedHere: "refused",
    notInList: "not in the list",
  },
};

export const LOCALES: Readonly<Record<string, Strings>> = { sk: SK, en: EN };

/** Slovak unless the served configuration asks for a language this application has. */
export function stringsFor(language?: string): Strings {
  const tag = (language ?? "sk").toLowerCase().split("-")[0];
  return LOCALES[tag] ?? SK;
}

/** The words a refused note is explained in, with the model's own bound filled in. */
export function noteWords(s: Strings) {
  return {
    tooLong: (max: number) => s.noteFault.tooLong.replace("{max}", String(max)),
    forbidden: s.noteFault.forbidden,
    notText: s.noteFault.notText,
  };
}
