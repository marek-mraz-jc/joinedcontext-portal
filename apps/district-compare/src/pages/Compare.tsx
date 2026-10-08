import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Grid, Page, pointOf, useEntities } from "@joinedcontext/sdk";
import { ChartCard } from "../components/ChartCard";
import { DistrictMap } from "../components/DistrictMap";
import { Empty, Loading, Problem } from "../components/states";
import { useCompare } from "../compare";
import type { DistrictOutput, Measure } from "../districts";
import {
  MEASURES,
  defaultSelection,
  hasPerKm2,
  measurePerKm2,
  measureValue,
  readHash,
  sortDistrictsByMeasure,
  toInput,
  writeHash,
} from "../districts";
import type { Lang } from "../i18n";
import { measureTitle, measureUnit, number, t, translateType } from "../i18n";

const DISTRICT_QUERY = { attrs: ["name", "districtCode", "divisionLevel", "location"] };
const EVENT_QUERY = { attrs: ["name", "startDate", "location"] };
const BIKE_QUERY = { attrs: ["name", "totalSlotNumber", "location"] };
const ALERT_QUERY = { attrs: ["name", "validFrom", "location"] };
const AIR_QUERY = { attrs: ["name", "pm25", "airQualityIndex", "dateObserved", "location"] };

function formatTableCell(
  d: DistrictOutput,
  m: Measure,
  lang: Lang,
  total: number,
  failed: boolean,
): React.JSX.Element | string {
  if (failed) return t(lang, "unreadable");
  const val = measureValue(d, m);
  if (m === "pm25" || m === "aqi") {
    if (val === null) return t(lang, "noStation");
    const rankStr = d.rank[m] !== null ? `${d.rank[m]} / ${total}` : "";
    return (
      <div className="app-table-cell">
        <span className="app-cell-val">
          {number(lang, val, 1)} {measureUnit(lang, m)}
        </span>
        {rankStr && <span className="app-cell-sub">{rankStr}</span>}
      </div>
    );
  }
  const count = number(lang, val ?? 0, 0);
  const perKm2Val = measurePerKm2(d, m);
  const perKm2 = perKm2Val !== null ? `${number(lang, perKm2Val, 1)} / km²` : "—";
  const rank = d.rank[m] !== null ? `${d.rank[m]} / ${total}` : "—";
  return (
    <div className="app-table-cell">
      <span className="app-cell-val">{count}</span>
      <span className="app-cell-sub">
        {perKm2}, {rank}
      </span>
    </div>
  );
}

function barChartOption(
  districts: DistrictOutput[],
  measure: Measure,
  lang: Lang,
): Record<string, unknown> | null {
  if (districts.length === 0) return null;
  const unit = measureUnit(lang, measure);
  return {
    grid: { left: 48, right: 16, top: 16, bottom: 44 },
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : params;
        const val = (p as { value?: unknown })?.value;
        const name = (p as { name?: unknown })?.name;
        if (val === null || val === undefined || val === "-") {
          return `${name}: ${t(lang, "noStation")}`;
        }
        return `${name}: ${val}${unit ? ` ${unit}` : ""}`;
      },
    },
    xAxis: {
      type: "category",
      data: districts.map((d) => d.name),
      axisLabel: { interval: 0, rotate: districts.length > 3 ? 30 : 0 },
    },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        data: districts.map((d) => {
          const v = measureValue(d, measure);
          return v === null ? "-" : v;
        }),
      },
    ],
  };
}

/**
 * Compare districts side by side: map choropleth, comparison table, bar chart, and ranked list.
 */
export function Compare({ lang }: { lang: Lang }): React.JSX.Element {
  const districtsRes = useEntities("CityDistrict", DISTRICT_QUERY);
  const eventsRes = useEntities("Event", EVENT_QUERY);
  const bikesRes = useEntities("BikeHireDockingStation", BIKE_QUERY);
  const alertsRes = useEntities("Alert", ALERT_QUERY);
  const airRes = useEntities("AirQualityObserved", AIR_QUERY);

  const [selectedCodes, setSelectedCodes] = useState<string[]>(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    return readHash(hash).selectedCodes;
  });
  const [measure, setMeasure] = useState<Measure>(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    return readHash(hash).measure;
  });
  const initialized = useRef(false);

  const districtRows = useMemo(
    () => districtsRes.rows.filter((r) => r.divisionLevel === "district"),
    [districtsRes.rows],
  );

  const geometries = useMemo(
    () => new Map(districtRows.map((r) => [String(r.districtCode ?? ""), r.location])),
    [districtRows],
  );

  const unlocatedEvents = useMemo(
    () => eventsRes.rows.filter((e) => pointOf(e.location) === null).length,
    [eventsRes.rows],
  );

  const failedTypes = useMemo(() => {
    const list: string[] = [];
    if (eventsRes.error) list.push("Event");
    if (bikesRes.error) list.push("BikeHireDockingStation");
    if (alertsRes.error) list.push("Alert");
    if (airRes.error) list.push("AirQualityObserved");
    return list;
  }, [eventsRes.error, bikesRes.error, alertsRes.error, airRes.error]);

  const compareInput = useMemo(() => {
    if (districtRows.length === 0) return null;
    return toInput({
      districts: districtRows,
      events: eventsRes.rows,
      bikes: bikesRes.rows,
      alerts: alertsRes.rows,
      air: airRes.rows,
    });
  }, [districtRows, eventsRes.rows, bikesRes.rows, alertsRes.rows, airRes.rows]);

  const { output, running, error: compareError } = useCompare(compareInput);

  useEffect(() => {
    const onHashChange = () => {
      const next = readHash(window.location.hash);
      if (next.selectedCodes.length > 0) {
        setSelectedCodes(next.selectedCodes);
      }
      setMeasure(next.measure);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!initialized.current && output && output.districts.length > 0) {
      initialized.current = true;
      if (selectedCodes.length === 0) {
        const initial = defaultSelection(output);
        setSelectedCodes(initial);
        try {
          window.history.replaceState(null, "", writeHash({ selectedCodes: initial, measure }));
        } catch {
          // sandboxed preview may refuse
        }
      }
    }
  }, [output, selectedCodes.length, measure]);

  const updateSelection = (codes: string[]) => {
    setSelectedCodes(codes);
    try {
      window.history.replaceState(null, "", writeHash({ selectedCodes: codes, measure }));
    } catch {
      // sandboxed preview may refuse
    }
  };

  const updateMeasure = (nextMeasure: Measure) => {
    setMeasure(nextMeasure);
    try {
      window.history.replaceState(null, "", writeHash({ selectedCodes, measure: nextMeasure }));
    } catch {
      // sandboxed preview may refuse
    }
  };

  const toggleDistrict = (code: string) => {
    const next = selectedCodes.includes(code)
      ? selectedCodes.filter((c) => c !== code)
      : [...selectedCodes, code];
    updateSelection(next);
  };

  const selectedDistricts = useMemo(() => {
    if (!output) return [];
    return selectedCodes
      .map((code) => output.districts.find((d) => d.code === code))
      .filter((d): d is DistrictOutput => d !== undefined);
  }, [output, selectedCodes]);

  const rankedDistricts = useMemo(() => {
    if (!output) return [];
    return sortDistrictsByMeasure(output.districts, measure);
  }, [output, measure]);

  const totalDistricts = output?.districts.length ?? 0;
  const chartOption = useMemo(() => barChartOption(selectedDistricts, measure, lang), [selectedDistricts, measure, lang]);

  const stillReading = useMemo(() => {
    const list: string[] = [];
    if (districtsRes.loading) list.push(translateType("CityDistrict", lang));
    if (eventsRes.loading) list.push(translateType("Event", lang));
    if (bikesRes.loading) list.push(translateType("BikeHireDockingStation", lang));
    if (alertsRes.loading) list.push(translateType("Alert", lang));
    if (airRes.loading) list.push(translateType("AirQualityObserved", lang));
    return list;
  }, [districtsRes.loading, eventsRes.loading, bikesRes.loading, alertsRes.loading, airRes.loading, lang]);

  const isDistrictsError = districtsRes.error !== null;
  const isEmptyDistricts = !districtsRes.loading && districtRows.length === 0 && !isDistrictsError;

  return (
    <Page label={t(lang, "page")}>
      <Problem error={districtsRes.error} onRetry={districtsRes.reload} />
      {compareError ? <Problem error={new Error(t(lang, "analysisFailed", { reason: compareError.message }))} /> : null}

      {failedTypes.length > 0 && !isDistrictsError && (
        <div className="jc-problem" role="status">
          <p>{t(lang, "partialFailed", { types: failedTypes.map((type) => translateType(type, lang)).join(", ") })}</p>
        </div>
      )}

      {districtsRes.loading && districtRows.length === 0 ? (
        <Loading label={`${t(lang, "loading")} (${stillReading.join(", ")})`} />
      ) : isEmptyDistricts ? (
        <Empty>{t(lang, "emptyDistricts")}</Empty>
      ) : (
        <>
          <div className="app-filter-bar">
            <label className="app-filter-field">
              <span>{t(lang, "measure")}</span>
              <select
                aria-label={t(lang, "measure")}
                value={measure}
                onChange={(e) => updateMeasure(e.target.value as Measure)}
              >
                {MEASURES.map((m) => (
                  <option key={m} value={m}>
                    {t(lang, `measure_${m}`)}
                  </option>
                ))}
              </select>
            </label>
            {selectedCodes.length > 0 && (
              <button type="button" className="jc-button" onClick={() => updateSelection([])}>
                {t(lang, "clear")}
              </button>
            )}
            {unlocatedEvents > 0 && (
              <span className="app-note">{unlocatedEvents === 1 ? t(lang, "unlocatedEvent") : t(lang, "unlocatedEvents", { n: unlocatedEvents })}</span>
            )}
          </div>

          <Card title={t(lang, "map")}>
            <DistrictMap
              districts={output?.districts ?? []}
              geometries={geometries}
              selectedCodes={selectedCodes}
              measure={measure}
              onToggle={toggleDistrict}
              label={t(lang, "map")}
            />
            <p className="app-legend-text">{t(lang, "mapLegend")}</p>
          </Card>

          <Card title={t(lang, "selectedDistrictsCompared")}>
            {selectedDistricts.length === 0 ? (
              <Empty>{t(lang, "noneSelected")}</Empty>
            ) : (
              <div className="jc-table-wrap">
                <table className="jc-table" aria-label={t(lang, "selectedDistrictsCompared")}>
                  <thead>
                    <tr>
                      <th scope="col">{t(lang, "measure")}</th>
                      {selectedDistricts.map((d) => (
                        <th key={d.code} scope="col">
                          <button
                            type="button"
                            className="app-remove-district"
                            onClick={() => toggleDistrict(d.code)}
                            aria-label={t(lang, "deselectDistrict", { name: d.name })}
                          >
                            {d.name} ×
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">{t(lang, "area")}</th>
                      {selectedDistricts.map((d) => (
                        <td key={d.code} className="jc-num" data-label={d.name}>
                          {number(lang, d.areaKm2, 2)} {t(lang, "km2")}
                        </td>
                      ))}
                    </tr>
                    {MEASURES.map((m) => {
                      const failed =
                        (m === "events" && failedTypes.includes("Event")) ||
                        ((m === "bikes" || m === "bikeSlots") && failedTypes.includes("BikeHireDockingStation")) ||
                        (m === "alerts" && failedTypes.includes("Alert")) ||
                        ((m === "pm25" || m === "aqi") && failedTypes.includes("AirQualityObserved"));
                      return (
                        <tr key={m}>
                          <th scope="row">{t(lang, `measure_${m}`)}</th>
                          {selectedDistricts.map((d) => (
                            <td key={d.code} className="jc-num" data-label={d.name}>
                              {formatTableCell(d, m, lang, totalDistricts, failed)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Grid columns={2}>
            <ChartCard
              title={t(lang, "chartTitle", { measure: measureTitle(lang, measure) })}
              option={chartOption}
              loading={running && !output}
              empty={t(lang, "chartEmpty")}
              height={300}
              onSelect={(name) => {
                const found = output?.districts.find((d) => d.name === name);
                if (found) toggleDistrict(found.code);
              }}
            />

            <Card title={t(lang, "districtsRanked")}>
              {!output ? (
                <Loading label={t(lang, "analysing")} />
              ) : (
                <ol className="app-ranked-list" aria-label={t(lang, "districtsRanked")}>
                  {rankedDistricts.map((d) => {
                    const isSelected = selectedCodes.includes(d.code);
                    const val = measureValue(d, measure);
                    const rank = d.rank[measure];
                    return (
                      <li key={d.code} className="app-ranked-item">
                        <label className="app-check">
                          <input
                            type="checkbox"
                            aria-label={d.name}
                            checked={isSelected}
                            onChange={() => toggleDistrict(d.code)}
                          />
                          <span className="app-district-rank">{rank !== null ? `#${rank}` : "—"}</span>
                          <span className="app-district-name">{d.name}</span>
                          <span className="app-district-val">
                            {val === null
                              ? t(lang, "noStation")
                              : `${number(lang, val, hasPerKm2(measure) ? 0 : 1)}${measureUnit(lang, measure) ? ` ${measureUnit(lang, measure)}` : ""}`}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          </Grid>
        </>
      )}
    </Page>
  );
}
