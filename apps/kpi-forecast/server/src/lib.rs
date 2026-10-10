//! The server of kpi-forecast (T-3350): every indicator's forecast kept with the day it was made,
//! so a later visit can set it against what was measured, and a monthly report of the forecasts
//! against the readings as CSV under the App's own prefix. The page still forecasts in the
//! browser for the period on screen; the day's first visit asks the server to record the day's
//! forecasts, made from the history the server reads itself.
//!
//! | Route | What it does |
//! |---|---|
//! | `POST /api/forecasts` `{days}` | the day's forecasts recorded, once a day per period |
//! | `GET /api/forecasts?kpi=&days=` | the forecasts kept for an indicator, newest first |
//! | `POST /api/reports` `{month}` | a month's forecasts (this month's by default) against the readings as CSV; a URL it downloads from |

use jc_app_sdk::blob::{self, Method};
use jc_app_sdk::gateway;
use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql::{self, Value};
use kpi_forecast::{analyse_series, Direction, Point, Series, Status};
use serde::Deserialize;
use serde_json::{json, Value as Json};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// What the App's policies let it read back: 90 days.
const READABLE: i64 = 90 * DAY;
/// The readings one temporal read asks for per indicator, as the page does (src/kpis.ts).
const LAST_N: usize = 2000;
/// Forecasts listed for one indicator.
const LISTED: i64 = 60;
/// How long a report's download URL lives; the host allows at most 300 seconds.
const URL_SECONDS: u32 = 120;

/// An indicator's id: its URN, of letters, digits and `._~:-`, at most 256 long.
pub fn kpi_urn(id: &str) -> Result<&str, String> {
    let rest = id
        .strip_prefix("urn:ngsi-ld:KeyPerformanceIndicator:")
        .unwrap_or_default();
    if rest.is_empty()
        || id.len() > 256
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._~:-".contains(c))
    {
        return Err(format!("{id} is not the id of an indicator"));
    }
    Ok(id)
}

/// The period, 7, 30 or 90 days, as the page offers it.
pub fn period(days: i64) -> Result<i64, String> {
    match days {
        7 | 30 | 90 => Ok(days),
        _ => Err(format!("{days} is not a period: 7, 30 or 90 days")),
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `2026-10-10T08:00:00Z` of epoch milliseconds, to the second.
pub fn iso(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(DAY));
    let s = ms.rem_euclid(DAY) / 1000;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        s / 3600,
        s % 3600 / 60,
        s % 60
    )
}

/// Epoch milliseconds of an RFC 3339 instant, any offset, fractions allowed.
pub fn instant(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, zone) = time.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (h, mi) = zone[1..].split_once(':')?;
        (
            clock,
            sign * (h.parse::<i64>().ok()? * HOUR + mi.parse::<i64>().ok()? * MINUTE),
        )
    };
    let mut c = clock.split(':');
    let (h, mi): (i64, i64) = (c.next()?.parse().ok()?, c.next()?.parse().ok()?);
    let seconds: f64 = c.next().unwrap_or("0").parse().ok()?;
    if !(1..=12).contains(&m)
        || !(1..=31).contains(&day)
        || h > 23
        || mi > 59
        || !(0.0..61.0).contains(&seconds)
    {
        return None;
    }
    Some(
        days_from_civil(y, m, day) * DAY + h * HOUR + mi * MINUTE + (seconds * 1000.0) as i64
            - offset,
    )
}

/// The first and the last instant of a month `YYYY-MM`, UTC: `[start, end)`.
pub fn month_bounds(month: &str) -> Result<(i64, i64), String> {
    let wrong = || format!("{month} is not a month: write it as YYYY-MM");
    let (y, m) = month.split_once('-').ok_or_else(wrong)?;
    if y.len() != 4 || m.len() != 2 {
        return Err(wrong());
    }
    let (y, m): (i64, i64) = (
        y.parse().map_err(|_| wrong())?,
        m.parse().map_err(|_| wrong())?,
    );
    if !(1..=12).contains(&m) {
        return Err(wrong());
    }
    let next = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    Ok((
        days_from_civil(y, m, 1) * DAY,
        days_from_civil(next.0, next.1, 1) * DAY,
    ))
}

/// Each indicator's `currentValue` readings from a temporal answer, as the page reads them.
pub fn series_of(entities: &[Json]) -> Vec<Series> {
    entities
        .iter()
        .filter_map(|entity| {
            let id = entity.get("id")?.as_str()?.to_owned();
            let property = entity.get("currentValue");
            let values = property.and_then(|p| {
                p.get("values")
                    .and_then(Json::as_array)
                    .or_else(|| p.as_array())
            });
            let points = values
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let (v, at) = match entry {
                        Json::Array(pair) if pair.len() >= 2 => {
                            (pair[0].as_f64()?, pair[1].as_str()?)
                        }
                        Json::Object(o) => {
                            (o.get("value")?.as_f64()?, o.get("observedAt")?.as_str()?)
                        }
                        _ => return None,
                    };
                    Some(Point {
                        t: instant(at)? as f64,
                        v,
                    })
                })
                .collect();
            Some(Series { id, points })
        })
        .collect()
}

/// The readings of every indicator from `from` on (to `to` when given), from the App's own Endpoint.
fn history(from: i64, to: Option<i64>) -> Result<Vec<Series>, Response> {
    let window = match to {
        Some(to) => format!(
            "timerel=between&timeAt={}&endTimeAt={}",
            gateway::encode(&iso(from)),
            gateway::encode(&iso(to))
        ),
        None => format!("timerel=after&timeAt={}", gateway::encode(&iso(from))),
    };
    let path = format!(
        "/ngsi-ld/v1/temporal/entities?type=KeyPerformanceIndicator&attrs=currentValue&{window}&lastN={LAST_N}&options=temporalValues"
    );
    let entities: Vec<Json> = gateway::get_json(&path).map_err(Response::from)?;
    Ok(series_of(&entities))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn bad(why: &str) -> Response {
    Response::problem(400, "Bad Request", why)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    days: i64,
}

/// The day's forecast of each indicator with enough history, as rows to keep.
pub fn forecasts_of(series: &[Series]) -> Vec<Json> {
    series
        .iter()
        .filter_map(|s| {
            let result = analyse_series(s, None);
            if result.status != Status::Ok || result.forecast.is_empty() {
                return None;
            }
            let direction = result.trend.as_ref().map(|t| match t.direction {
                Direction::Up => "up",
                Direction::Down => "down",
                Direction::Flat => "flat",
            });
            let last = result.history.last()?;
            Some(json!({"kpi": s.id, "step": result.step?, "latest_t": last[0], "latest_v": last[1], "direction": direction, "points": result.forecast}))
        })
        .collect()
}

fn record(request: &Request, _: &Params) -> Response {
    let wanted: Record = match request.json() {
        Ok(wanted) => wanted,
        Err(answer) => return answer,
    };
    let days = match period(wanted.days) {
        Ok(days) => days,
        Err(why) => return bad(&why),
    };
    // Once a day per period: a later visit that day reads nothing and records nothing.
    match sql::query(
        "select 1 as one from forecasts where made_on = current_date and days = $1 limit 1",
        &[Value::from(days)],
    ) {
        Ok(rows) if !rows.values.is_empty() => {
            return Response::json(200, &json!({"recorded": 0, "already": true}))
        }
        Ok(_) => {}
        Err(err) => return Response::from_sql(err),
    }
    let series = match history(now() - days * DAY, None) {
        Ok(series) => series,
        Err(answer) => return answer,
    };
    let rows = forecasts_of(&series);
    if rows.is_empty() {
        return Response::json(200, &json!({"recorded": 0, "already": false}));
    }
    match sql::execute(
        "insert into forecasts (kpi, made_on, days, step, latest_t, latest_v, direction, points) \
         select r.kpi, current_date, $1, r.step, r.latest_t, r.latest_v, r.direction, r.points \
         from jsonb_to_recordset($2) as r(kpi text, step double precision, latest_t double precision, latest_v double precision, direction text, points jsonb) \
         where r.kpi like 'urn:ngsi-ld:KeyPerformanceIndicator:%' and length(r.kpi) <= 256 \
         on conflict (kpi, made_on, days) do nothing",
        &[Value::from(days), Value::Json(Json::from(rows).to_string())],
    ) {
        Ok(n) => Response::json(201, &json!({"recorded": n, "already": false})),
        Err(err) => Response::from_sql(err),
    }
}

fn list(request: &Request, _: &Params) -> Response {
    let kpi = match kpi_urn(request.param("kpi").unwrap_or_default()) {
        Ok(kpi) => kpi,
        Err(why) => return bad(&why),
    };
    let days = match request.param("days").map(str::parse::<i64>) {
        None => None,
        Some(Ok(d)) => match period(d) {
            Ok(d) => Some(d),
            Err(why) => return bad(&why),
        },
        Some(Err(_)) => return bad("the period is 7, 30 or 90 days"),
    };
    let rows = sql::query(
        "select made_on::text as \"madeOn\", days, step, latest_t as \"latestT\", latest_v as \"latestV\", direction, points \
         from forecasts where kpi = $1 and ($2::int is null or days = $2::int) order by made_on desc, days limit $3",
        &[Value::from(kpi), Value::from(days), Value::from(LISTED)],
    );
    match rows {
        Ok(rows) => Response::json(200, &sql::objects(&rows)),
        Err(err) => Response::from_sql(err),
    }
}

/// One cell of the report: quoted when it holds a separator, a quote or a line break, and never
/// read as a formula by a spreadsheet.
pub fn cell(text: &str) -> String {
    let text = if text.starts_with(['=', '+', '-', '@', '\t', '\r']) && text.parse::<f64>().is_err()
    {
        format!("'{text}")
    } else {
        text.to_owned()
    };
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// The reading nearest `t` within half a step, if any.
pub fn measured_at(series: Option<&Series>, t: f64, step: f64) -> Option<f64> {
    series?
        .points
        .iter()
        .filter(|p| p.v.is_finite() && (p.t - t).abs() <= step / 2.0)
        .min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))
        .map(|p| p.v)
}

/// The report: every kept forecast point that falls in the month, against the reading at that
/// time when there is one.
pub fn report(month: &str, forecasts: &[Json], readings: &[Series]) -> String {
    let (start, end) = month_bounds(month).unwrap_or((0, 0));
    let mut out = format!("# kpi-forecast: forecasts for {month} against the readings\nkpi,made_on,period_days,for_utc,expected,low_95,high_95,measured,within_95\n");
    for f in forecasts {
        let kpi = f.get("kpi").and_then(Json::as_str).unwrap_or_default();
        let made_on = f.get("madeOn").and_then(Json::as_str).unwrap_or_default();
        let days = f.get("days").and_then(Json::as_i64).unwrap_or_default();
        let step = f
            .get("step")
            .and_then(Json::as_f64)
            .unwrap_or(f64::INFINITY);
        let series = readings.iter().find(|s| s.id == kpi);
        for p in f
            .get("points")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(t), Some(v), Some(lo), Some(hi)) = (
                p["t"].as_f64(),
                p["v"].as_f64(),
                p["lo"].as_f64(),
                p["hi"].as_f64(),
            ) else {
                continue;
            };
            if !((start as f64)..(end as f64)).contains(&t) {
                continue;
            }
            let measured = measured_at(series, t, step);
            out.push_str(&format!(
                "{},{},{days},{},{v},{lo},{hi},{},{}\n",
                cell(kpi),
                cell(made_on),
                iso(t as i64),
                measured.map_or(String::new(), |m| m.to_string()),
                measured.map_or("", |m| if (lo..=hi).contains(&m) { "yes" } else { "no" }),
            ));
        }
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Month {
    /// `YYYY-MM`; this month (UTC) when absent.
    #[serde(default)]
    month: Option<String>,
}

fn monthly(request: &Request, _: &Params) -> Response {
    let wanted: Month = match request.json() {
        Ok(wanted) => wanted,
        Err(answer) => return answer,
    };
    let now = now();
    let this_month = {
        let (y, m, _) = civil_from_days(now.div_euclid(DAY));
        format!("{y:04}-{m:02}")
    };
    let month = wanted
        .month
        .as_deref()
        .map_or(this_month.as_str(), str::trim);
    let (start, end) = match month_bounds(month) {
        Ok(bounds) => bounds,
        Err(why) => return bad(&why),
    };
    if start > now {
        return bad("that month has not begun");
    }
    if end <= now - READABLE {
        return bad("a report covers a month of the last 90 days, the history the App may read");
    }
    let key = format!("reports/{month}.csv");
    // A month that is over and written after it ended is final: it is not written again.
    let final_report = match sql::query("select 1 as one from reports where month = $1 and written_at >= to_timestamp($2::double precision / 1000)", &[Value::from(month), Value::from(end as f64)]) {
        Ok(rows) => !rows.values.is_empty(),
        Err(err) => return Response::from_sql(err),
    };
    if !final_report {
        let forecasts = match sql::query(
            "select kpi, made_on::text as \"madeOn\", days, step, points from forecasts \
             where made_on >= to_timestamp($1::double precision / 1000)::date - 90 and made_on < to_timestamp($2::double precision / 1000)::date \
             order by kpi, made_on, days limit 1000",
            &[Value::from(start as f64), Value::from(end as f64)],
        ) {
            Ok(rows) => sql::objects(&rows).into_iter().map(Json::Object).collect::<Vec<_>>(),
            Err(err) => return Response::from_sql(err),
        };
        let readings = match history(start.max(now - READABLE + MINUTE), Some(end.min(now))) {
            Ok(series) => series,
            Err(answer) => return answer,
        };
        if let Err(err) = blob::put(
            &key,
            report(month, &forecasts, &readings).as_bytes(),
            Some("text/csv; charset=utf-8"),
        ) {
            return Response::from_blob(err);
        }
        if let Err(err) = sql::execute(
            "insert into reports (month) values ($1) on conflict (month) do update set written_at = now()",
            &[Value::from(month)],
        ) {
            return Response::from_sql(err);
        }
    }
    match blob::presign(&key, Method::Get, URL_SECONDS) {
        Ok(url) => Response::json(
            201,
            &json!({"month": month, "url": url, "expiresIn": URL_SECONDS, "final": final_report || end <= now}),
        ),
        Err(err) => Response::from_blob(err),
    }
}

pub fn handle(request: Request) -> Response {
    Router::new()
        .post("/api/forecasts", record)
        .get("/api/forecasts", list)
        .post("/api/reports", monthly)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;

    const KPI: &str = "urn:ngsi-ld:KeyPerformanceIndicator:helsinki:bikes-in-use";

    #[test]
    fn an_indicator_is_a_kpi_urn_and_a_period_one_the_page_offers() {
        assert_eq!(kpi_urn(KPI), Ok(KPI));
        for wrong in [
            "",
            "urn:ngsi-ld:KeyPerformanceIndicator:",
            "urn:ngsi-ld:Vehicle:1",
            "urn:ngsi-ld:KeyPerformanceIndicator:a,b",
            "urn:ngsi-ld:KeyPerformanceIndicator:a b",
        ] {
            assert!(kpi_urn(wrong).is_err(), "{wrong}");
        }
        assert_eq!(period(30), Ok(30));
        for wrong in [0, 1, 14, 365, -7] {
            assert!(period(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn a_month_runs_from_its_first_day_to_the_next_months() {
        let (start, end) = month_bounds("2026-02").expect("a month");
        assert_eq!(iso(start), "2026-02-01T00:00:00Z");
        assert_eq!(iso(end), "2026-03-01T00:00:00Z");
        assert_eq!(
            iso(month_bounds("2026-12").expect("december").1),
            "2027-01-01T00:00:00Z"
        );
        for wrong in [
            "",
            "2026",
            "2026-13",
            "2026-00",
            "26-01",
            "2026-1",
            "2026-01-01",
            "abcd-ef",
        ] {
            assert!(month_bounds(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn readings_are_the_current_values_with_a_time() {
        let entities = vec![
            json!({"id": KPI, "currentValue": {"type": "Property", "values": [[12.5, "2026-10-01T10:00:00Z"], ["n/a", "2026-10-01T11:00:00Z"], [13, "bad"]]}}),
            json!({"id": "urn:ngsi-ld:KeyPerformanceIndicator:x", "currentValue": [{"value": 4, "observedAt": "2026-10-01T10:00:00+03:00"}]}),
            json!({"id": "urn:ngsi-ld:KeyPerformanceIndicator:empty"}),
            json!({"currentValue": []}),
        ];
        let series = series_of(&entities);
        assert_eq!(series.len(), 3);
        assert_eq!(series[0].points.len(), 1);
        assert_eq!(series[0].points[0].v, 12.5);
        assert_eq!(
            series[1].points[0].t,
            instant("2026-10-01T07:00:00Z").expect("t") as f64
        );
        assert!(series[2].points.is_empty());
    }

    #[test]
    fn a_forecast_is_kept_for_an_indicator_with_enough_history_only() {
        let t0 = instant("2026-09-01T00:00:00Z").expect("t") as f64;
        let long = Series {
            id: KPI.into(),
            points: (0..60)
                .map(|i| Point {
                    t: t0 + f64::from(i) * DAY as f64,
                    v: 100.0 + f64::from(i) + f64::from(i % 7),
                })
                .collect(),
        };
        let short = Series {
            id: "urn:ngsi-ld:KeyPerformanceIndicator:short".into(),
            points: vec![Point { t: t0, v: 1.0 }],
        };
        let rows = forecasts_of(&[long, short]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kpi"], KPI);
        assert_eq!(rows[0]["step"], DAY as f64);
        assert_eq!(rows[0]["direction"], "up");
        assert!(rows[0]["points"]
            .as_array()
            .is_some_and(|p| !p.is_empty() && p[0]["lo"].as_f64() <= p[0]["v"].as_f64()));
    }

    #[test]
    fn the_report_sets_each_forecast_point_of_the_month_against_its_reading() {
        let t = |s: &str| instant(s).expect("t") as f64;
        let forecasts = vec![
            json!({"kpi": KPI, "madeOn": "2026-09-30", "days": 30, "step": DAY as f64, "points": [
                {"t": t("2026-09-30T12:00:00Z"), "v": 10.0, "lo": 8.0, "hi": 12.0},
                {"t": t("2026-10-01T12:00:00Z"), "v": 11.0, "lo": 9.0, "hi": 13.0},
                {"t": t("2026-10-02T12:00:00Z"), "v": 12.0, "lo": 10.0, "hi": 14.0},
                {"t": t("2026-10-03T12:00:00Z"), "v": 13.0, "lo": 11.0, "hi": 15.0}
            ]}),
        ];
        let readings = vec![Series {
            id: KPI.into(),
            points: vec![
                Point {
                    t: t("2026-10-01T13:00:00Z"),
                    v: 12.0,
                },
                Point {
                    t: t("2026-10-02T12:00:00Z"),
                    v: 20.0,
                },
            ],
        }];
        let text = report("2026-10", &forecasts, &readings);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[1],
            "kpi,made_on,period_days,for_utc,expected,low_95,high_95,measured,within_95"
        );
        assert_eq!(lines.len(), 5, "{text}");
        assert_eq!(
            lines[2],
            format!("{KPI},2026-09-30,30,2026-10-01T12:00:00Z,11,9,13,12,yes")
        );
        assert_eq!(
            lines[3],
            format!("{KPI},2026-09-30,30,2026-10-02T12:00:00Z,12,10,14,20,no")
        );
        assert_eq!(
            lines[4],
            format!("{KPI},2026-09-30,30,2026-10-03T12:00:00Z,13,11,15,,")
        );
        assert_eq!(report("2026-10", &[], &[]).lines().count(), 2);
    }

    #[test]
    fn a_report_cell_is_never_a_formula_but_a_negative_number_stays_one() {
        assert_eq!(cell("-5"), "-5");
        assert_eq!(cell("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(cell("@x"), "'@x");
        assert_eq!(cell("a,b"), "\"a,b\"");
        assert_eq!(measured_at(None, 0.0, 1.0), None);
    }
}
