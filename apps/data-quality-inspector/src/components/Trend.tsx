import { useEffect, useState } from "react";
import { Card, Empty } from "@joinedcontext/sdk";
import { number, t } from "../i18n";
import type { Lang } from "../i18n";
import type { Run, Server } from "../server";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A share as a percentage in the language's way, or a dash for no score. */
const percent = (lang: Lang, share: number | null) => (share === null ? "–" : `${number(lang, share * 100, 1)} %`);

/** A run's time on Helsinki's clock. */
function when(lang: Lang, iso: string): string {
  return new Intl.DateTimeFormat(lang === "fi" ? "fi-FI" : "en-GB", { timeZone: "Europe/Helsinki", dateStyle: "medium", timeStyle: "short" }).format(Date.parse(iso));
}

/**
 * Quality over time (T-3354): every run the App's server kept, the newest first, with its
 * completeness, validity and findings, a run now on request, and each run's full per-entity
 * report as a file.
 */
export function Trend({ lang, server }: { lang: Lang; server: Server }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; problem: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let gone = false;
    server.runs().then(
      (answer) => {
        if (gone) return;
        setRuns(answer.runs);
        setStale(answer.stale);
        setFailed(null);
      },
      (error: unknown) => !gone && setFailed(reason(error)),
    );
    return () => {
      gone = true;
    };
  }, [server, nonce]);

  const runNow = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await server.runNow();
      setSaid({ text: t(lang, "ran"), problem: false });
      setNonce((n) => n + 1);
    } catch (error) {
      setSaid({ text: t(lang, "runFailed", { reason: reason(error) }), problem: true });
    } finally {
      setBusy(false);
    }
  };

  const download = async (run: Run) => {
    try {
      window.open(await server.reportUrl(run.id), "_blank", "noopener");
    } catch (error) {
      setSaid({ text: t(lang, "reportFailed", { reason: reason(error) }), problem: true });
    }
  };

  return (
    <Card title={t(lang, "trend")}>
      <p className="app-note">{t(lang, "trendNote")}</p>
      <div className="app-trend-actions">
        <button type="button" className="jc-button" disabled={busy} onClick={() => void runNow()}>
          {busy ? t(lang, "running") : t(lang, "runNow")}
        </button>
      </div>
      {said && (
        <p className={said.problem ? "jc-problem" : "app-note"} role={said.problem ? "alert" : "status"}>
          {said.text}
        </p>
      )}
      {failed ? (
        <p className="jc-problem" role="alert">
          {t(lang, "trendFailed", { reason: failed })}
        </p>
      ) : !runs ? (
        <p className="app-note">{t(lang, "trendReading")}</p>
      ) : runs.length === 0 ? (
        <Empty>{t(lang, "trendEmpty")}</Empty>
      ) : (
        <>
          {stale && <p className="app-note">{t(lang, "trendStale")}</p>}
          {/* Scrolls sideways on a phone: a keyboard reaches it as a named region (WCAG 2.1.1). */}
          <div className="jc-table-wrap" tabIndex={0} role="region" aria-label={t(lang, "trend")}>
            <table className="jc-table" aria-label={t(lang, "trend")}>
              <thead>
                <tr>
                  <th scope="col">{t(lang, "ranAt")}</th>
                  <th scope="col">{t(lang, "entitiesColumn")}</th>
                  <th scope="col">{t(lang, "completeColumn")}</th>
                  <th scope="col">{t(lang, "validColumn")}</th>
                  <th scope="col">{t(lang, "findingsColumn")}</th>
                  <th scope="col">{t(lang, "fullReport")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th scope="row">{when(lang, run.ran_at)}</th>
                    <td className="jc-num">{number(lang, run.entities)}</td>
                    <td className="jc-num">{percent(lang, run.completeness)}</td>
                    <td className="jc-num">{percent(lang, run.valid)}</td>
                    <td className="jc-num">{number(lang, run.findings)}</td>
                    <td>
                      <button
                        type="button"
                        className="jc-button"
                        aria-label={t(lang, "fullReportOf", { when: when(lang, run.ran_at) })}
                        onClick={() => void download(run)}
                      >
                        {t(lang, "fullReport")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
