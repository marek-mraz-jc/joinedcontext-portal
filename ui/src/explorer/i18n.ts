// The catalogue widget's strings (T-5082): its own i18next instance, holding only the namespaces
// the Endpoint data view reads in English and Slovak. The explorer build points the Portal's
// `src/i18n` here, so nothing pulls the four whole Portal catalogues into the script.
import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { app as enApp, endpoints as enEndpoints, entityGrid as enGrid, spaces as enSpaces } from "../locales/en.json";
import { app as skApp, endpoints as skEndpoints, entityGrid as skGrid, spaces as skSpaces } from "../locales/sk.json";

// The data toolbar (T-6303) reads spaces.toolbar and spaces.saved: those two blocks, not the namespace.
const enToolbar = { toolbar: enSpaces.toolbar, saved: enSpaces.saved };
const skToolbar = { toolbar: skSpaces.toolbar, saved: skSpaces.saved };

const i18n = i18next.createInstance().use(ICU).use(initReactI18next);

void i18n.init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: { translation: { app: enApp, endpoints: enEndpoints, entityGrid: enGrid, spaces: enToolbar } },
    sk: { translation: { app: skApp, endpoints: skEndpoints, entityGrid: skGrid, spaces: skToolbar } },
  },
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
});

export default i18n;
