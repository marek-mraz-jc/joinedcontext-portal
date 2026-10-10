//! The server half of alerts-heatmap (T-3351): what the browser cannot keep. The city's feed holds
//! the alerts of today and drops old ones, so the server reads the feed through the App's own
//! Endpoint with the caller's token, finds each week's repeat places with the browser's own
//! analysis (`../wasm`), and keeps them in its own schema. A reader can also save the view they
//! are looking at as a hotspot report, with a snapshot of the map stored under the App's prefix.
//! The interactive part, every filter and click, stays in the browser.
//!
//! | Route | What it does |
//! |---|---|
//! | `GET /api/weeks` | the repeat places per week, recomputed from the feed when older than six hours |
//! | `GET /api/reports` | the saved reports, newest first |
//! | `POST /api/reports` `{title, view, kept, places}` | a report saved |
//! | `GET /api/reports/{id}` | one report |
//! | `POST /api/reports/{id}/snapshot` | a URL to upload the report's map snapshot to, once |
//! | `GET /api/reports/{id}/snapshot` | a URL to download it from |

use std::collections::BTreeMap;

use alerts_heatmap::{run, time, Alert, Filter, Input};
use jc_app_sdk::blob::{self, Method};
use jc_app_sdk::gateway;
use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql::{self, Value};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

/// How long a presigned URL lives; the host allows at most 300 seconds.
const URL_SECONDS: u32 = 120;
/// Alerts read from the feed per page, and at most in all (the browser's own ceiling).
const PAGE: usize = 500;
const MOST: usize = 5000;
/// Reports kept; saving one more drops the oldest, so a public page cannot fill the App's quota.
const KEPT_REPORTS: i64 = 200;
/// Repeat places kept per week and per report.
const TOP: usize = 10;
const MS_PER_DAY: i64 = 86_400_000;

/// One repeat place as a report or a week keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spot {
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewReport {
    pub title: String,
    pub view: String,
    pub kept: u32,
    #[serde(default)]
    pub places: Vec<Spot>,
}

/// A report as it is stored: the title trimmed, the view a query string of the page's own
/// parameters, at most [`TOP`] places, each inside the map's world.
pub fn checked(report: NewReport) -> Result<NewReport, String> {
    let title = report.title.trim().to_owned();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("a report's title has 1 to 120 characters".into());
    }
    let view = report.view.trim_start_matches('?').to_owned();
    if view.len() > 500
        || !view
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"=&,_-.%+:".contains(&b))
    {
        return Err(
            "a report's view is the page's address after `?`, at most 500 characters".into(),
        );
    }
    if report.places.len() > TOP {
        return Err(format!("a report keeps at most {TOP} places"));
    }
    for place in &report.places {
        if place.name.chars().count() > 200
            || !(-180.0..=180.0).contains(&place.lon)
            || !(-90.0..=90.0).contains(&place.lat)
        {
            return Err("a place has a name of at most 200 characters and a longitude and latitude on the map".into());
        }
    }
    Ok(NewReport {
        title,
        view,
        ..report
    })
}

/// Milliseconds since the epoch of an ISO 8601 date-time (`2026-10-08T07:30:00Z`,
/// `…+03:00`, fractions allowed), or of a keyValues DateTime (`{"@type": "DateTime", "@value": …}`).
pub fn instant(value: &Json) -> Option<i64> {
    let text = match value {
        Json::String(text) => text.as_str(),
        Json::Object(map) => map.get("@value")?.as_str()?,
        _ => return None,
    };
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b' ')
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" | "" => 0,
        zone if zone.len() == 6 && matches!(&zone[..1], "+" | "-") && &zone[3..4] == ":" => {
            let minutes = zone[1..3].parse::<i64>().ok()? * 60 + zone[4..6].parse::<i64>().ok()?;
            if zone.starts_with('-') {
                -minutes
            } else {
                minutes
            }
        }
        _ => return None,
    };
    let days = time::days_from_civil(year, month as u32, day as u32);
    Some(days * MS_PER_DAY + ((hour * 60 + minute - offset_minutes) * 60 + second) * 1000 + millis)
}

/// Monday of an instant's week on Helsinki's calendar, `YYYY-MM-DD`.
pub fn week_of(utc_ms: i64) -> String {
    let local = utc_ms + time::helsinki_offset_hours(utc_ms) * 3_600_000;
    let days = local.div_euclid(MS_PER_DAY);
    let monday = days - i64::from(time::weekday(days));
    let (year, month, day) = time::civil_from_days(monday);
    format!("{year:04}-{month:02}-{day:02}")
}

/// A keyValues text as a person reads it: a string, the Finnish or English of a language map,
/// or a postal address's street.
pub fn text_of(value: Option<&Json>) -> String {
    match value {
        Some(Json::String(text)) => text.clone(),
        Some(Json::Object(map)) => ["fi", "en", "streetAddress", "addressLocality"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Json::as_str))
            .or_else(|| map.values().find_map(Json::as_str))
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

/// The repeat places of each week of `entities` (keyValues Alerts), the most alerts first, each
/// named by its first alert.
pub fn weekly(entities: &[Json]) -> BTreeMap<String, (u32, Vec<Spot>)> {
    let mut weeks: BTreeMap<String, Vec<&Json>> = BTreeMap::new();
    for entity in entities {
        let start = ["validFrom", "dateIssued"]
            .iter()
            .find_map(|attr| entity.get(*attr).and_then(instant));
        if let Some(start) = start {
            weeks.entry(week_of(start)).or_default().push(entity);
        }
    }
    weeks
        .into_iter()
        .map(|(week, alerts)| {
            let input = Input {
                alerts: alerts
                    .iter()
                    .map(|entity| Alert {
                        id: entity["id"].as_str().unwrap_or_default().to_owned(),
                        geometry: entity.get("location").cloned().unwrap_or(Json::Null),
                        time: None,
                        sub_category: None,
                    })
                    .collect(),
                filter: Filter::default(),
                hex_size: 600.0,
                eps: 120.0,
                min_points: 3,
            };
            let output = run(&input);
            let by_id: BTreeMap<&str, &Json> = alerts
                .iter()
                .filter_map(|entity| Some((entity["id"].as_str()?, *entity)))
                .collect();
            let spots = output
                .places
                .iter()
                .take(TOP)
                .map(|place| Spot {
                    name: place
                        .ids
                        .iter()
                        .find_map(|id| {
                            let entity = by_id.get(id.as_str())?;
                            let name = text_of(entity.get("name"));
                            let name = if name.is_empty() {
                                text_of(entity.get("address"))
                            } else {
                                name
                            };
                            (!name.is_empty()).then_some(name)
                        })
                        .unwrap_or_default(),
                    lon: place.lon,
                    lat: place.lat,
                    count: u32::try_from(place.count).unwrap_or(u32::MAX),
                })
                .collect();
            (
                week,
                (u32::try_from(alerts.len()).unwrap_or(u32::MAX), spots),
            )
        })
        .collect()
}

/// Every Alert the App's Endpoint lets the caller read, page by page, up to [`MOST`].
fn alerts() -> Result<Vec<Json>, String> {
    let mut all = Vec::new();
    loop {
        let path = format!(
            "/ngsi-ld/v1/entities?type=Alert&options=keyValues&limit={PAGE}&offset={}&attrs={}",
            all.len(),
            gateway::encode("name,address,validFrom,dateIssued,location"),
        );
        let page: Vec<Json> = gateway::get(&path)?.json()?;
        let last = page.len() < PAGE;
        all.extend(page);
        if last || all.len() >= MOST {
            all.truncate(MOST);
            return Ok(all);
        }
    }
}

/// Reads the feed and stores each week's repeat places; a week the feed no longer holds keeps
/// what was stored for it.
fn refresh() -> Result<(), Response> {
    let entities = alerts().map_err(|why| Response::problem(502, "Bad Gateway", &why))?;
    for (week, (count, spots)) in weekly(&entities) {
        sql::execute(
            "insert into weekly_places (week, alerts, places, computed_at) values ($1::date, $2, $3::jsonb, now()) \
             on conflict (week) do update set alerts = excluded.alerts, places = excluded.places, computed_at = now()",
            &[
                Value::from(week),
                Value::from(i64::from(count)),
                Value::Json(serde_json::to_string(&spots).unwrap_or_else(|_| "[]".into())),
            ],
        )
        .map_err(Response::from_sql)?;
    }
    Ok(())
}

fn weeks(_: &Request, _: &Params) -> Response {
    let fresh = match sql::query(
        "select count(*) from weekly_places where computed_at > now() - interval '6 hours'",
        &[],
    ) {
        Ok(rows) => !matches!(
            rows.values.first().and_then(|row| row.first()),
            Some(Value::Int(0)) | None
        ),
        Err(err) => return Response::from_sql(err),
    };
    // A feed that cannot be read leaves what is stored readable, and says so.
    let problem = if fresh { None } else { refresh().err() };
    match sql::query(
        r#"select week::text as week, alerts, places, to_char(computed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as computed_at from weekly_places order by week desc limit 104"#,
        &[],
    ) {
        Ok(rows) if rows.values.is_empty() && problem.is_some() => {
            problem.unwrap_or_else(Response::no_content)
        }
        Ok(rows) => Response::json(
            200,
            &json!({ "weeks": sql::objects(&rows), "stale": problem.is_some() }),
        ),
        Err(err) => Response::from_sql(err),
    }
}

fn id(params: &Params) -> Result<i64, Response> {
    params["id"]
        .parse()
        .map_err(|_| Response::problem(404, "Not Found", "no such report"))
}

const REPORT: &str = r#"id, title, view, kept, places, snapshot is not null as has_snapshot, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at"#;

fn list(_: &Request, _: &Params) -> Response {
    match sql::query(
        &format!("select {REPORT} from reports order by id desc limit 50"),
        &[],
    ) {
        Ok(rows) => Response::json(200, &sql::objects(&rows)),
        Err(err) => Response::from_sql(err),
    }
}

fn one(_: &Request, params: &Params) -> Response {
    let id = match id(params) {
        Ok(id) => id,
        Err(answer) => return answer,
    };
    match sql::query(
        &format!("select {REPORT} from reports where id = $1"),
        &[Value::from(id)],
    ) {
        Ok(rows) => match sql::objects(&rows).into_iter().next() {
            Some(report) => Response::json(200, &report),
            None => Response::problem(404, "Not Found", "no such report"),
        },
        Err(err) => Response::from_sql(err),
    }
}

/// Drops the reports beyond the newest [`KEPT_REPORTS`], their snapshots first.
fn trim() -> Result<(), Response> {
    let old = sql::query(
        "select snapshot from reports where snapshot is not null and id < \
         (select coalesce(min(id), 0) from (select id from reports order by id desc limit $1) newest)",
        &[Value::from(KEPT_REPORTS)],
    )
    .map_err(Response::from_sql)?;
    for row in &old.values {
        if let Some(Value::Text(key)) = row.first() {
            match blob::delete(key) {
                Ok(()) | Err(blob::Error::NotFound) => {}
                Err(err) => return Err(Response::from_blob(err)),
            }
        }
    }
    sql::execute(
        "delete from reports where id < (select coalesce(min(id), 0) from (select id from reports order by id desc limit $1) newest)",
        &[Value::from(KEPT_REPORTS)],
    )
    .map(drop)
    .map_err(Response::from_sql)
}

fn save(request: &Request, _: &Params) -> Response {
    let report = match request.json::<NewReport>().map(checked) {
        Ok(Ok(report)) => report,
        Ok(Err(why)) => return Response::problem(400, "Bad Request", &why),
        Err(answer) => return answer,
    };
    let saved = sql::query(
        &format!("insert into reports (title, view, kept, places) values ($1, $2, $3, $4::jsonb) returning {REPORT}"),
        &[
            Value::from(report.title),
            Value::from(report.view),
            Value::from(i64::from(report.kept)),
            Value::Json(serde_json::to_string(&report.places).unwrap_or_else(|_| "[]".into())),
        ],
    );
    match saved {
        Ok(rows) => {
            if let Err(answer) = trim() {
                return answer;
            }
            Response::json(201, &sql::objects(&rows).into_iter().next())
        }
        Err(err) => Response::from_sql(err),
    }
}

fn snapshot_key(id: i64) -> String {
    format!("reports/{id}/map.png")
}

fn upload(_: &Request, params: &Params) -> Response {
    let id = match id(params) {
        Ok(id) => id,
        Err(answer) => return answer,
    };
    // Once only: a snapshot belongs to the report as it was saved, and nobody replaces another's.
    match sql::execute(
        "update reports set snapshot = $1 where id = $2 and snapshot is null",
        &[Value::from(snapshot_key(id)), Value::from(id)],
    ) {
        Ok(0) => match sql::query("select 1 from reports where id = $1", &[Value::from(id)]) {
            Ok(rows) if rows.values.is_empty() => {
                Response::problem(404, "Not Found", "no such report")
            }
            Ok(_) => Response::problem(409, "Conflict", "this report already has its map snapshot"),
            Err(err) => Response::from_sql(err),
        },
        Ok(_) => match blob::presign(&snapshot_key(id), Method::Put, URL_SECONDS) {
            Ok(url) => Response::json(
                200,
                &json!({"url": url, "method": "PUT", "contentType": "image/png"}),
            ),
            Err(err) => Response::from_blob(err),
        },
        Err(err) => Response::from_sql(err),
    }
}

fn download(_: &Request, params: &Params) -> Response {
    let id = match id(params) {
        Ok(id) => id,
        Err(answer) => return answer,
    };
    match sql::query(
        "select snapshot from reports where id = $1",
        &[Value::from(id)],
    ) {
        Ok(rows) => match rows.values.first().and_then(|row| row.first()) {
            None => Response::problem(404, "Not Found", "no such report"),
            Some(Value::Text(key)) => match blob::presign(key, Method::Get, URL_SECONDS) {
                Ok(url) => Response::json(200, &json!({ "url": url })),
                Err(err) => Response::from_blob(err),
            },
            Some(_) => Response::problem(404, "Not Found", "this report has no map snapshot"),
        },
        Err(err) => Response::from_sql(err),
    }
}

pub fn handle(request: Request) -> Response {
    Router::new()
        .get("/api/weeks", weeks)
        .get("/api/reports", list)
        .post("/api/reports", save)
        .get("/api/reports/{id}", one)
        .post("/api/reports/{id}/snapshot", upload)
        .get("/api/reports/{id}/snapshot", download)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;

    fn report(title: &str, view: &str, places: Vec<Spot>) -> NewReport {
        NewReport {
            title: title.into(),
            view: view.into(),
            kept: 3,
            places,
        }
    }

    fn spot(lon: f64, lat: f64) -> Spot {
        Spot {
            name: "Mannerheimintie".into(),
            lon,
            lat,
            count: 4,
        }
    }

    #[test]
    fn a_report_is_trimmed_and_checked() {
        let ok = checked(report(
            "  Road works in May ",
            "?from=2026-05-01&kind=ROAD_WORK&day=0&hour=7&lang=fi",
            vec![spot(24.94, 60.17)],
        ))
        .unwrap();
        assert_eq!(ok.title, "Road works in May");
        assert_eq!(
            ok.view,
            "from=2026-05-01&kind=ROAD_WORK&day=0&hour=7&lang=fi"
        );
        assert!(checked(report("   ", "", vec![])).is_err());
        assert!(checked(report(&"x".repeat(121), "", vec![])).is_err());
        assert!(
            checked(report("t", "a=<script>", vec![])).is_err(),
            "only the page's own parameters"
        );
        assert!(checked(report("t", &"a".repeat(501), vec![])).is_err());
        assert!(checked(report("t", "", vec![spot(200.0, 60.0)])).is_err());
        assert!(checked(report("t", "", vec![spot(24.9, 60.1); 11])).is_err());
    }

    #[test]
    fn a_date_time_is_read_with_its_zone_or_not_at_all() {
        let utc = instant(&json!("2026-10-08T07:30:00Z")).unwrap();
        assert_eq!(
            utc,
            time::days_from_civil(2026, 10, 8) * MS_PER_DAY + (7 * 60 + 30) * 60_000
        );
        assert_eq!(instant(&json!("2026-10-08T10:30:00+03:00")), Some(utc));
        assert_eq!(instant(&json!("2026-10-08T07:30:00.25Z")), Some(utc + 250));
        assert_eq!(
            instant(&json!({"@type": "DateTime", "@value": "2026-10-08T07:30:00Z"})),
            Some(utc)
        );
        for bad in [
            json!("2026-13-08T07:30:00Z"),
            json!("yesterday"),
            json!("2026-10-08T07:30:00.Z"),
            json!("2026-10-08T07:30:00+0300"),
            json!(5),
        ] {
            assert_eq!(instant(&bad), None, "{bad}");
        }
    }

    #[test]
    fn a_week_starts_on_monday_on_helsinkis_clock() {
        // Sunday 2026-10-11 22:30 UTC is already Monday 01:30 in Helsinki (UTC+3).
        let late_sunday = instant(&json!("2026-10-11T22:30:00Z")).unwrap();
        assert_eq!(week_of(late_sunday), "2026-10-12");
        assert_eq!(
            week_of(instant(&json!("2026-10-11T20:00:00Z")).unwrap()),
            "2026-10-05"
        );
        // Across New Year: Thursday 2026-01-01 is in the week of Monday 2025-12-29.
        assert_eq!(
            week_of(instant(&json!("2026-01-01T12:00:00Z")).unwrap()),
            "2025-12-29"
        );
    }

    #[test]
    fn a_text_is_read_from_a_string_a_language_map_or_an_address() {
        assert_eq!(text_of(Some(&json!("Hämeentie"))), "Hämeentie");
        assert_eq!(
            text_of(Some(&json!({"en": "Main street", "fi": "Pääkatu"}))),
            "Pääkatu"
        );
        assert_eq!(
            text_of(Some(
                &json!({"streetAddress": "Hämeentie 3", "postalCode": "00530"})
            )),
            "Hämeentie 3"
        );
        assert_eq!(text_of(Some(&json!(7))), "");
        assert_eq!(text_of(None), "");
    }

    fn alert(id: &str, lon: f64, lat: f64, start: &str, name: Option<&str>) -> Json {
        let mut entity = json!({"id": id, "type": "Alert", "validFrom": start,
            "location": {"type": "Point", "coordinates": [lon, lat]},
            "address": {"streetAddress": "Hämeentie 3"}});
        if let Some(name) = name {
            entity["name"] = json!(name);
        }
        entity
    }

    #[test]
    fn each_week_keeps_its_own_repeat_places() {
        let entities = vec![
            alert("a1", 24.9500, 60.1700, "2026-10-05T08:00:00Z", None),
            alert(
                "a2",
                24.9501,
                60.1701,
                "2026-10-06T08:00:00Z",
                Some("Tietyö"),
            ),
            alert("a3", 24.9502, 60.1700, "2026-10-07T08:00:00Z", None),
            // The next week: one alert far away, no repeat place.
            alert("b1", 25.1000, 60.2500, "2026-10-13T08:00:00Z", None),
            // No time: in no week.
            json!({"id": "c1", "type": "Alert", "location": {"type": "Point", "coordinates": [24.95, 60.17]}}),
        ];
        let weeks = weekly(&entities);
        assert_eq!(
            weeks.keys().collect::<Vec<_>>(),
            ["2026-10-05", "2026-10-12"]
        );
        let (count, spots) = &weeks["2026-10-05"];
        assert_eq!(*count, 3);
        assert_eq!(spots.len(), 1);
        assert_eq!(spots[0].count, 3);
        assert_eq!(
            spots[0].name, "Hämeentie 3",
            "the first alert's name, else its address"
        );
        assert_eq!(weeks["2026-10-12"], (1, vec![]));
        assert!(weekly(&[]).is_empty());
    }

    #[test]
    fn a_route_outside_the_api_or_a_bad_id_is_answered_in_words() {
        let get = |path: &str| {
            handle(Request {
                method: "GET".into(),
                path: path.into(),
                ..Request::default()
            })
        };
        assert_eq!(get("/api/nothing").status, 404);
        assert_eq!(get("/api/reports/abc").status, 404);
        let wrong = handle(Request {
            method: "DELETE".into(),
            path: "/api/reports".into(),
            ..Request::default()
        });
        assert_eq!(wrong.status, 405);
        let bad = handle(Request {
            method: "POST".into(),
            path: "/api/reports".into(),
            body: b"{\"title\": 1}".to_vec(),
            ..Request::default()
        });
        assert_eq!(bad.status, 400);
    }
}
