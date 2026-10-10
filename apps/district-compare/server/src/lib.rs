//! The server half of district-compare (T-3353): what the browser cannot keep. The feeds hold
//! today's events, stations, alerts and readings, so once a day on Helsinki's calendar the server
//! reads them through the App's own Endpoint with the caller's token, runs the browser's own
//! comparison (`../wasm`) and keeps each district's figures for that day in its own schema: a
//! district gets a history. It also keeps the district boundaries it compared against as a
//! GeoJSON file with its licence under the App's prefix. Choosing districts and a measure stays in
//! the browser.
//!
//! | Route | What it does |
//! |---|---|
//! | `GET /api/metrics?codes=101,102` | the kept days of up to six districts, the newest first; today's computed first when missing |
//! | `GET /api/boundaries` | URLs to download the boundaries and their licence from |

use district_compare::{run, AirInput, BikeInput, DistrictInput, Input, Output};
use jc_app_sdk::blob::{self, Method};
use jc_app_sdk::gateway;
use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql::{self, Value};
use serde_json::{json, Value as Json};

/// How long a presigned URL lives; the host allows at most 300 seconds.
const URL_SECONDS: u32 = 120;
/// Entities read from the feed per page, and at most per type.
const PAGE: usize = 500;
const MOST: usize = 5000;
/// Districts compared at once, as the page allows, and days answered per district.
const MOST_CODES: usize = 6;
const DAYS: i64 = 120;
const BOUNDARIES: &str = "boundaries/districts.geojson";
const LICENCE: &str = "boundaries/LICENCE.txt";
/// Where the boundaries come from and under which terms: the platform's district pipeline reads
/// them from this layer, published under CC BY 4.0 (deployment's helsinki-datasource-districts).
const LICENCE_TEXT: &str = "Helsinki's districts (kaupunginosajako)\n\n\
Source: City of Helsinki, the open WFS layer avoindata:Kaupunginosajako\n\
(https://kartta.hel.fi/ws/geoserver/avoindata/wfs), listed in the Helsinki Region Infoshare\n\
catalogue as the package helsingin-piirijako.\n\
Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),\n\
https://creativecommons.org/licenses/by/4.0/\n\n\
This file holds the boundaries as the joinedcontext platform's CityDistrict entities carried them\n\
on the day written below; the App district-compare wrote it.\n";

/// A keyValues text as a person reads it: a string, the Finnish or English of a language map.
pub fn text_of(value: Option<&Json>) -> String {
    match value {
        Some(Json::String(text)) => text.clone(),
        Some(Json::Number(number)) => number.to_string(),
        Some(Json::Object(map)) => ["fi", "en", "sv"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Json::as_str))
            .or_else(|| map.values().find_map(Json::as_str))
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

/// Where an entity is, as the browser places it: a Point's coordinates, else the first vertex of
/// a line or polygon; `None` when it has no place.
pub fn point_of(value: Option<&Json>) -> Option<Vec<f64>> {
    let mut coordinates = value?.get("coordinates")?;
    while let Some(first) = coordinates
        .as_array()
        .and_then(|c| c.first())
        .filter(|c| c.is_array())
    {
        coordinates = first;
    }
    let pair = coordinates.as_array()?;
    Some(vec![pair.first()?.as_f64()?, pair.get(1)?.as_f64()?])
}

/// A number, or a number written as text.
pub fn number_of(value: Option<&Json>) -> Option<f64> {
    match value? {
        Json::Number(number) => number.as_f64(),
        Json::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// The feeds' entities as the comparison takes them, as the browser builds its input: districts
/// of the level `district` only, an entity with no place counted outside every district.
pub fn input(
    districts: &[Json],
    events: &[Json],
    bikes: &[Json],
    alerts: &[Json],
    air: &[Json],
) -> Input {
    let nowhere = || vec![999.0, 999.0];
    Input {
        districts: districts
            .iter()
            .filter(|d| d.get("divisionLevel").and_then(Json::as_str) == Some("district"))
            .map(|d| {
                let code = text_of(d.get("districtCode"));
                let name = text_of(d.get("name"));
                DistrictInput {
                    name: if name.trim().is_empty() || name.starts_with("urn:") {
                        code.clone()
                    } else {
                        name
                    },
                    code,
                    geometry: d.get("location").cloned().unwrap_or(Json::Null),
                }
            })
            .collect(),
        events: events
            .iter()
            .map(|e| point_of(e.get("location")).unwrap_or_else(nowhere))
            .collect(),
        bikes: bikes
            .iter()
            .map(|b| BikeInput {
                at: Some(point_of(b.get("location")).unwrap_or_else(nowhere)),
                slots: number_of(b.get("totalSlotNumber")).map(|n| n as i64),
            })
            .collect(),
        alerts: alerts
            .iter()
            .map(|a| point_of(a.get("location")).unwrap_or_else(nowhere))
            .collect(),
        air: air
            .iter()
            .map(|a| AirInput {
                at: Some(point_of(a.get("location")).unwrap_or_else(nowhere)),
                pm25: number_of(a.get("pm25")),
                aqi: number_of(a.get("airQualityIndex")),
            })
            .collect(),
    }
}

/// The districts the comparison ran on as a GeoJSON FeatureCollection, each with its code and name.
pub fn boundaries(input: &Input) -> Json {
    json!({
        "type": "FeatureCollection",
        "features": input.districts.iter().filter(|d| d.geometry.is_object()).map(|d| json!({
            "type": "Feature",
            "properties": {"code": d.code, "name": d.name},
            "geometry": d.geometry,
        })).collect::<Vec<_>>(),
    })
}

/// The codes a request asks for: 1 to [`MOST_CODES`], each 1 to 20 letters, digits, `-` or `_`.
pub fn codes(raw: Option<&str>) -> Result<Vec<String>, String> {
    let codes: Vec<String> = raw
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned)
        .collect();
    if codes.is_empty() || codes.len() > MOST_CODES {
        return Err(format!(
            "name 1 to {MOST_CODES} districts by their codes: ?codes=101,102"
        ));
    }
    if codes.iter().any(|c| {
        c.len() > 20
            || !c
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) {
        return Err("a district's code is 1 to 20 letters, digits, dashes or underscores".into());
    }
    Ok(codes)
}

/// Every entity of `kind` the App's Endpoint lets the caller read, page by page, up to [`MOST`].
fn entities(kind: &str, attrs: &str) -> Result<Vec<Json>, gateway::Error> {
    let mut all = Vec::new();
    loop {
        let path = format!(
            "/ngsi-ld/v1/entities?type={kind}&options=keyValues&limit={PAGE}&offset={}&attrs={}",
            all.len(),
            gateway::encode(attrs),
        );
        let page: Vec<Json> = gateway::get_json(&path)?;
        let last = page.len() < PAGE;
        all.extend(page);
        if last || all.len() >= MOST {
            all.truncate(MOST);
            return Ok(all);
        }
    }
}

/// Reads the feeds, compares, and keeps today's figures of every district and the boundaries.
fn refresh() -> Result<(), Response> {
    let read = |kind: &str, attrs: &str| entities(kind, attrs).map_err(|err| refused(kind, err));
    let districts = read("CityDistrict", "name,districtCode,divisionLevel,location")?;
    let input = input(
        &districts,
        &read("Event", "location")?,
        &read("BikeHireDockingStation", "totalSlotNumber,location")?,
        &read("Alert", "location")?,
        &read("AirQualityObserved", "pm25,airQualityIndex,location")?,
    );
    let output: Output = run(&input);
    for d in &output.districts {
        sql::execute(
            "insert into district_metrics (day, code, name, area_km2, events, bikes, bike_slots, alerts, pm25, aqi, computed_at) \
             values ((now() at time zone 'Europe/Helsinki')::date, $1, $2, $3, $4, $5, $6, $7, $8::float8, $9::float8, now()) \
             on conflict (day, code) do update set name = excluded.name, area_km2 = excluded.area_km2, events = excluded.events, \
             bikes = excluded.bikes, bike_slots = excluded.bike_slots, alerts = excluded.alerts, pm25 = excluded.pm25, \
             aqi = excluded.aqi, computed_at = now()",
            &[
                Value::from(d.code.clone()),
                Value::from(d.name.clone()),
                Value::from(d.area_km2),
                Value::from(d.events as i64),
                Value::from(d.bikes as i64),
                Value::from(d.bike_slots as i64),
                Value::from(d.alerts as i64),
                Value::from(d.pm25),
                Value::from(d.aqi),
            ],
        )
        .map_err(Response::from_sql)?;
    }
    if !output.districts.is_empty() {
        let day = sql::query(
            "select (now() at time zone 'Europe/Helsinki')::date::text",
            &[],
        )
        .ok()
        .and_then(
            |rows| match rows.values.first().and_then(|row| row.first()) {
                Some(Value::Text(day)) => Some(day.clone()),
                _ => None,
            },
        )
        .unwrap_or_default();
        blob::put(
            BOUNDARIES,
            boundaries(&input).to_string().as_bytes(),
            Some("application/geo+json"),
        )
        .map_err(Response::from_blob)?;
        blob::put(
            LICENCE,
            format!("{LICENCE_TEXT}\nWritten: {day}\n").as_bytes(),
            Some("text/plain; charset=utf-8"),
        )
        .map_err(Response::from_blob)?;
    }
    Ok(())
}

fn metrics(request: &Request, _: &Params) -> Response {
    let codes = match codes(request.param("codes")) {
        Ok(codes) => codes,
        Err(why) => return Response::problem(400, "Bad Request", &why),
    };
    let today = match sql::query(
        "select count(*) from district_metrics where day = (now() at time zone 'Europe/Helsinki')::date",
        &[],
    ) {
        Ok(rows) => !matches!(rows.values.first().and_then(|row| row.first()), Some(Value::Int(0)) | None),
        Err(err) => return Response::from_sql(err),
    };
    // Feeds that cannot be read leave what is stored readable, and say so.
    let problem = if today { None } else { refresh().err() };
    match sql::query(
        "select day::text as day, code, name, area_km2, events, bikes, bike_slots, alerts, pm25, aqi from district_metrics \
         where code = any(string_to_array($1, ',')) and day > (now() at time zone 'Europe/Helsinki')::date - $2::int \
         order by day desc, code",
        &[Value::from(codes.join(",")), Value::from(DAYS)],
    ) {
        Ok(rows) if rows.values.is_empty() && problem.is_some() => problem.unwrap_or_else(Response::no_content),
        Ok(rows) => Response::json(200, &json!({ "days": sql::objects(&rows), "stale": problem.is_some() })),
        Err(err) => Response::from_sql(err),
    }
}

fn files(_: &Request, _: &Params) -> Response {
    match blob::list("boundaries/") {
        Ok(keys) if !keys.iter().any(|k| k == BOUNDARIES) => Response::problem(
            404,
            "Not Found",
            "the server has not kept the boundaries yet: they are written with the first day's figures",
        ),
        Ok(_) => match (
            blob::presign(BOUNDARIES, Method::Get, URL_SECONDS),
            blob::presign(LICENCE, Method::Get, URL_SECONDS),
        ) {
            (Ok(geojson), Ok(licence)) => Response::json(200, &json!({ "geojson": geojson, "licence": licence })),
            (Err(err), _) | (_, Err(err)) => Response::from_blob(err),
        },
        Err(err) => Response::from_blob(err),
    }
}

/// A read of `kind` that failed: the caller's own 401 or 403 as the gateway said it, anything else
/// the gateway's, naming the type.
fn refused(kind: &str, err: gateway::Error) -> Response {
    match err {
        gateway::Error::Status(401 | 403, _) => Response::from(err),
        other => Response::problem(502, "Bad Gateway", &format!("{kind}: {other}")),
    }
}

pub fn handle(request: Request) -> Response {
    Router::new()
        .get("/api/metrics", metrics)
        .get("/api/boundaries", files)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;

    const SQUARE: [[f64; 2]; 5] = [
        [24.90, 60.15],
        [24.96, 60.15],
        [24.96, 60.18],
        [24.90, 60.18],
        [24.90, 60.15],
    ];

    fn district(code: Json, name: Json, level: &str) -> Json {
        json!({"id": "urn:ngsi-ld:CityDistrict:d", "type": "CityDistrict", "districtCode": code, "name": name, "divisionLevel": level,
               "location": {"type": "Polygon", "coordinates": [SQUARE]}})
    }

    fn at(lon: f64, lat: f64) -> Json {
        json!({"type": "Point", "coordinates": [lon, lat]})
    }

    #[test]
    fn a_place_is_a_points_coordinates_or_a_shapes_first_vertex() {
        assert_eq!(point_of(Some(&at(24.9, 60.1))), Some(vec![24.9, 60.1]));
        assert_eq!(
            point_of(Some(&json!({"type": "Polygon", "coordinates": [SQUARE]}))),
            Some(vec![24.90, 60.15])
        );
        assert_eq!(
            point_of(Some(&json!({"type": "Point", "coordinates": ["a", 1]}))),
            None
        );
        assert_eq!(point_of(Some(&json!("Mannerheimintie"))), None);
        assert_eq!(point_of(None), None);
    }

    #[test]
    fn a_number_may_be_written_as_text() {
        assert_eq!(number_of(Some(&json!(12))), Some(12.0));
        assert_eq!(number_of(Some(&json!(" 7.5 "))), Some(7.5));
        assert_eq!(number_of(Some(&json!("many"))), None);
        assert_eq!(number_of(None), None);
    }

    #[test]
    fn the_input_is_built_as_the_browser_builds_it() {
        let input = input(
            &[
                district(
                    json!(101),
                    json!({"fi": "Vironniemi", "sv": "Estnäs"}),
                    "district",
                ),
                district(json!("102"), json!("urn:ngsi-ld:x"), "district"),
                district(json!("10"), json!("Eteläinen"), "major"),
            ],
            &[
                json!({"location": at(24.93, 60.16)}),
                json!({"id": "no place"}),
            ],
            &[json!({"location": at(24.93, 60.16), "totalSlotNumber": "20"})],
            &[],
            &[json!({"location": at(24.93, 60.16), "pm25": 4.2, "airQualityIndex": "2"})],
        );
        assert_eq!(
            input
                .districts
                .iter()
                .map(|d| (d.code.as_str(), d.name.as_str()))
                .collect::<Vec<_>>(),
            [("101", "Vironniemi"), ("102", "102")]
        );
        assert_eq!(
            input.events[1],
            vec![999.0, 999.0],
            "no place counts outside every district"
        );
        let output = run(&input);
        let first = &output.districts.iter().find(|d| d.code == "101").unwrap();
        assert_eq!((first.events, first.bikes, first.bike_slots), (1, 1, 20));
        assert_eq!((first.pm25, first.aqi), (Some(4.2), Some(2.0)));
        assert_eq!(output.outside.events, 1);
        let geojson = boundaries(&input);
        assert_eq!(geojson["features"].as_array().map(Vec::len), Some(2));
        assert_eq!(geojson["features"][0]["properties"]["name"], "Vironniemi");
    }

    #[test]
    fn a_request_names_one_to_six_codes() {
        assert_eq!(
            codes(Some("101, 102")),
            Ok(vec!["101".into(), "102".into()])
        );
        assert!(codes(None).is_err());
        assert!(codes(Some(",,")).is_err());
        assert!(codes(Some("1,2,3,4,5,6,7")).is_err());
        assert!(codes(Some("101;drop")).is_err());
        assert!(codes(Some(&"9".repeat(21))).is_err());
    }

    #[test]
    fn the_licence_names_its_source_and_terms() {
        assert!(LICENCE_TEXT.contains("CC BY 4.0") && LICENCE_TEXT.contains("helsingin-piirijako"));
    }

    #[test]
    fn a_route_outside_the_api_or_without_codes_is_answered_in_words() {
        let get = |path: &str| {
            handle(Request {
                method: "GET".into(),
                path: path.into(),
                ..Request::default()
            })
        };
        assert_eq!(get("/api/nothing").status, 404);
        let bare = get("/api/metrics");
        assert_eq!(bare.status, 400);
        assert!(String::from_utf8_lossy(&bare.body).contains("?codes=101,102"));
    }
}
