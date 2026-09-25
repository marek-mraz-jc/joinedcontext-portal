// The application's own words in each language it speaks (AP-126). English is the reference:
// every other catalog carries exactly its keys and its `{placeholders}`, which the tests hold.
// Add a language by adding a catalog to CATALOGS; add a word by adding a key to all of them.

const en = {
  "app.name": "Application",
  "app.noTypes": "This endpoint publishes no entity types.",
  "nav.label": "Pages",
  "nav.none": "No pages.",
  "page.overview": "Overview",
  "state.loading": "Loading…",
  "state.empty": "Nothing to show.",
  "state.retry": "Retry",
  "overview.open": "Open",
  "overview.entities": "Entities",
  "overview.from": "From {endpoint}",
  "overview.summary": "Server summary",
  "stat.average": "Average {attr}",
  "chart.averageBy": "Average {measure} by {category}",
  "chart.countBy": "{type} by {category}",
  "chart.overTime": "{measure} over time",
  "chart.empty": "Nothing to chart for the current filters.",
  "chart.other": "Other",
  "detail.none": "Select an entity to see its details.",
  "detail.close": "Close",
  "detail.edit": "Edit",
  "export.label": "Export",
  "export.noGeometry": "No geometry in these rows",
  "table.previous": "Previous",
  "table.next": "Next",
  "table.page": "Page {page} of {pages}",
  "filter.search": "Search",
  "filter.all": "All",
  "filter.from": "{label} from",
  "filter.to": "{label} to",
  "map.label": "Map",
  "form.edit": "Edit {type}",
  "form.new": "New {type}",
  "form.localId": "Local id",
  "form.latLon": "lat, lon",
  "form.notInList": "{value} (not in the list)",
  "form.save": "Save",
  "form.saving": "Saving…",
  "form.cancel": "Cancel",
  "form.number": "must be a number",
  "form.atLeast": "must be at least {min}",
  "form.atMost": "must be at most {max}",
  "form.point": "must be \"lat, lon\"",
  "form.oneOf": "must be one of {options}",
  "form.pattern": "does not match the expected format",
} as const;

export type MessageKey = keyof typeof en;
type Catalog = Record<MessageKey, string>;

const sk: Catalog = {
  "app.name": "Aplikácia",
  "app.noTypes": "Tento endpoint nezverejňuje žiadne typy entít.",
  "nav.label": "Stránky",
  "nav.none": "Žiadne stránky.",
  "page.overview": "Prehľad",
  "state.loading": "Načítava sa…",
  "state.empty": "Nie je čo zobraziť.",
  "state.retry": "Skúsiť znova",
  "overview.open": "Otvoriť",
  "overview.entities": "Entity",
  "overview.from": "Z {endpoint}",
  "overview.summary": "Súhrn zo servera",
  "stat.average": "Priemer {attr}",
  "chart.averageBy": "Priemer {measure} podľa {category}",
  "chart.countBy": "{type} podľa {category}",
  "chart.overTime": "{measure} v čase",
  "chart.empty": "Pre aktuálne filtre nie je čo zobraziť v grafe.",
  "chart.other": "Ostatné",
  "detail.none": "Vyberte entitu a zobrazia sa jej podrobnosti.",
  "detail.close": "Zavrieť",
  "detail.edit": "Upraviť",
  "export.label": "Export",
  "export.noGeometry": "Tieto riadky nemajú geometriu",
  "table.previous": "Predchádzajúca",
  "table.next": "Ďalšia",
  "table.page": "Strana {page} z {pages}",
  "filter.search": "Hľadať",
  "filter.all": "Všetko",
  "filter.from": "{label} od",
  "filter.to": "{label} do",
  "map.label": "Mapa",
  "form.edit": "Upraviť {type}",
  "form.new": "Nový {type}",
  "form.localId": "Lokálne id",
  "form.latLon": "šírka, dĺžka",
  "form.notInList": "{value} (nie je v zozname)",
  "form.save": "Uložiť",
  "form.saving": "Ukladá sa…",
  "form.cancel": "Zrušiť",
  "form.number": "musí byť číslo",
  "form.atLeast": "musí byť aspoň {min}",
  "form.atMost": "musí byť najviac {max}",
  "form.point": "musí mať tvar „šírka, dĺžka“",
  "form.oneOf": "musí byť jedna z hodnôt {options}",
  "form.pattern": "nezodpovedá očakávanému formátu",
};

const de: Catalog = {
  "app.name": "Anwendung",
  "app.noTypes": "Dieser Endpunkt veröffentlicht keine Entitätstypen.",
  "nav.label": "Seiten",
  "nav.none": "Keine Seiten.",
  "page.overview": "Übersicht",
  "state.loading": "Wird geladen…",
  "state.empty": "Nichts anzuzeigen.",
  "state.retry": "Erneut versuchen",
  "overview.open": "Öffnen",
  "overview.entities": "Entitäten",
  "overview.from": "Aus {endpoint}",
  "overview.summary": "Zusammenfassung vom Server",
  "stat.average": "Durchschnitt {attr}",
  "chart.averageBy": "Durchschnitt {measure} nach {category}",
  "chart.countBy": "{type} nach {category}",
  "chart.overTime": "{measure} im Zeitverlauf",
  "chart.empty": "Für die aktuellen Filter gibt es nichts darzustellen.",
  "chart.other": "Sonstige",
  "detail.none": "Wählen Sie eine Entität, um ihre Details zu sehen.",
  "detail.close": "Schließen",
  "detail.edit": "Bearbeiten",
  "export.label": "Export",
  "export.noGeometry": "Diese Zeilen haben keine Geometrie",
  "table.previous": "Zurück",
  "table.next": "Weiter",
  "table.page": "Seite {page} von {pages}",
  "filter.search": "Suchen",
  "filter.all": "Alle",
  "filter.from": "{label} von",
  "filter.to": "{label} bis",
  "map.label": "Karte",
  "form.edit": "{type} bearbeiten",
  "form.new": "{type} anlegen",
  "form.localId": "Lokale ID",
  "form.latLon": "Breite, Länge",
  "form.notInList": "{value} (nicht in der Liste)",
  "form.save": "Speichern",
  "form.saving": "Wird gespeichert…",
  "form.cancel": "Abbrechen",
  "form.number": "muss eine Zahl sein",
  "form.atLeast": "muss mindestens {min} sein",
  "form.atMost": "darf höchstens {max} sein",
  "form.point": "muss „Breite, Länge“ sein",
  "form.oneOf": "muss einer der Werte {options} sein",
  "form.pattern": "entspricht nicht dem erwarteten Format",
};

const cs: Catalog = {
  "app.name": "Aplikace",
  "app.noTypes": "Tento endpoint nezveřejňuje žádné typy entit.",
  "nav.label": "Stránky",
  "nav.none": "Žádné stránky.",
  "page.overview": "Přehled",
  "state.loading": "Načítá se…",
  "state.empty": "Není co zobrazit.",
  "state.retry": "Zkusit znovu",
  "overview.open": "Otevřít",
  "overview.entities": "Entity",
  "overview.from": "Z {endpoint}",
  "overview.summary": "Souhrn ze serveru",
  "stat.average": "Průměr {attr}",
  "chart.averageBy": "Průměr {measure} podle {category}",
  "chart.countBy": "{type} podle {category}",
  "chart.overTime": "{measure} v čase",
  "chart.empty": "Pro aktuální filtry není co zobrazit v grafu.",
  "chart.other": "Ostatní",
  "detail.none": "Vyberte entitu a zobrazí se její podrobnosti.",
  "detail.close": "Zavřít",
  "detail.edit": "Upravit",
  "export.label": "Export",
  "export.noGeometry": "Tyto řádky nemají geometrii",
  "table.previous": "Předchozí",
  "table.next": "Další",
  "table.page": "Strana {page} z {pages}",
  "filter.search": "Hledat",
  "filter.all": "Vše",
  "filter.from": "{label} od",
  "filter.to": "{label} do",
  "map.label": "Mapa",
  "form.edit": "Upravit {type}",
  "form.new": "Nový {type}",
  "form.localId": "Lokální id",
  "form.latLon": "šířka, délka",
  "form.notInList": "{value} (není v seznamu)",
  "form.save": "Uložit",
  "form.saving": "Ukládá se…",
  "form.cancel": "Zrušit",
  "form.number": "musí být číslo",
  "form.atLeast": "musí být alespoň {min}",
  "form.atMost": "musí být nejvýše {max}",
  "form.point": "musí mít tvar „šířka, délka“",
  "form.oneOf": "musí být jedna z hodnot {options}",
  "form.pattern": "neodpovídá očekávanému formátu",
};

export const CATALOGS: Readonly<Record<string, Catalog>> = { en, sk, de, cs };

/** The first of `candidates` (BCP 47 tags, best first) whose language has a catalog; English otherwise. */
export function pickLanguage(candidates: readonly (string | null | undefined)[]): string {
  for (const tag of candidates) {
    const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
    if (primary && Object.hasOwn(CATALOGS, primary)) return primary;
  }
  return "en";
}

/** The language the person asked for: `?lang=`, then the browser's, then the configuration's. */
export function requestedLanguage(configured?: string): string {
  const query = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("lang");
  const browser = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return pickLanguage([query, ...browser, configured]);
}

// One language per page load: the app sets it once, before its first page renders.
let current = "en";

/** Sets the language every `t` call answers in, and the document's, for screen readers (WCAG 3.1.1). */
export function setLanguage(language: string): void {
  current = pickLanguage([language]);
  if (typeof document !== "undefined") document.documentElement.lang = current;
}

/** The language `t` answers in. */
export function language(): string {
  return current;
}

/** The text of `key` in the current language, `{name}` filled from `vars`. */
export function t(key: MessageKey, vars?: Readonly<Record<string, string | number>>): string {
  const text = (CATALOGS[current] ?? en)[key];
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole)) : text;
}
