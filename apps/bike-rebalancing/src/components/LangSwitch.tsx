import { useLang } from "../i18n";
import { readParams, writeParams } from "../url";

/**
 * Suomi or English: the choice is written into the address (`?lang=`) and the page reloads in it,
 * so every text, number and date follows at once and a shared link keeps the language.
 */
export function LangSwitch({ label }: { label: string }): React.JSX.Element {
  const lang = useLang();
  const choose = (next: "fi" | "en") => {
    if (next === lang) return;
    const params = readParams(window.location.search);
    params.set("lang", next);
    writeParams(params);
    window.location.reload();
  };
  return (
    <div className="app-lang" role="group" aria-label={label}>
      <button type="button" lang="fi" aria-pressed={lang === "fi"} onClick={() => choose("fi")}>
        Suomi
      </button>
      <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => choose("en")}>
        English
      </button>
    </div>
  );
}
