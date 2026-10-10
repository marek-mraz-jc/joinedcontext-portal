//! The server half of bike-weather-demand (T-3355): what the browser cannot keep. The broker holds
//! a station's last seven days; the server trains the browser's own model (`../wasm`) on them once
//! a day per station, through the App's own Endpoint with the caller's token, and keeps the model's
//! weather coefficients, spread and hour-of-week profile in its own schema, so a station's model
//! has a history. The data it trained on is a file under the App's prefix. Picking a station and
//! reading the estimate stays in the browser.
//!
//! | Route | What it does |
//! |---|---|
//! | `GET /api/models?station=<urn>` | the station's kept models, newest first; today's trained first when missing |
//! | `GET /api/models/{id}/snapshot` | a URL to download the data a model was trained on |

use bike_weather_demand::{run_estimate, BikePointInput, Input, WeatherPointInput};
use jc_app_sdk::blob::{self, Method};
use jc_app_sdk::gateway;
use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql::{self, Value};
use serde_json::{json, Value as Json};

/// How long a presigned URL lives; the host allows at most 300 seconds.
const URL_SECONDS: u32 = 120;
/// How far the nearest weather station may be, as the browser's own rule.
const WEATHER_KM: f64 = 10.0;
/// Weather stations read at most.
const MOST_WEATHER: usize = 500;
/// Models answered at most per station.
const MODELS: i64 = 60;

/// A station id as a request may name it: an NGSI-LD URN, no space, comma, slash or `%`.
pub fn station_id(raw: Option<&str>) -> Result<String, String> {
    let id = raw.unwrap_or_default().trim();
    if id.len() < 5
        || id.len() > 300
        || !id.starts_with("urn:")
        || id
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, ',' | '/' | '%' | '?' | '#'))
    {
        return Err(
            "name the station by its id: ?station=urn:ngsi-ld:BikeHireDockingStation:…".into(),
        );
    }
    Ok(id.to_owned())
}

/// A storage key for a station's training data on a day, from a hash of its id: an id may hold
/// what a key may not (`..`, `:`).
pub fn snapshot_key(station: &str, day: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in station.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("training/{day}/{hash:016x}.json")
}

/// The great-circle distance in kilometres, as the browser's `haversineKm`.
pub fn haversine_km(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    let (d_lat, d_lon) = ((lat2 - lat1).to_radians(), (lon2 - lon1).to_radians());
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    6371.0 * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// A Point's coordinates, else the first vertex of a shape.
pub fn point_of(value: Option<&Json>) -> Option<(f64, f64)> {
    let mut coordinates = value?.get("coordinates")?;
    while let Some(first) = coordinates
        .as_array()
        .and_then(|c| c.first())
        .filter(|c| c.is_array())
    {
        coordinates = first;
    }
    let pair = coordinates.as_array()?;
    Some((pair.first()?.as_f64()?, pair.get(1)?.as_f64()?))
}

/// The weather station nearest to `at` within [`WEATHER_KM`], as the browser picks it.
pub fn nearest_weather(at: (f64, f64), stations: &[Json]) -> Option<String> {
    stations
        .iter()
        .filter_map(|s| {
            let (lon, lat) = point_of(s.get("location"))?;
            let distance = haversine_km(at.0, at.1, lon, lat);
            let id = s["id"].as_str()?.to_owned();
            (distance <= WEATHER_KM).then_some((distance, id))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id)
}

/// A number, or a number written as text, through a keyValues wrapper.
fn number_of(value: &Json) -> Option<f64> {
    match value {
        Json::Number(n) => n.as_f64(),
        Json::String(text) => text.trim().parse().ok().filter(|v: &f64| v.is_finite()),
        Json::Object(o) => o
            .get("@value")
            .or_else(|| o.get("value"))
            .and_then(number_of),
        _ => None,
    }
}

/// One attribute's points of a temporal answer, `(value, observedAt)`, in either of the shapes the
/// broker writes (`temporalValues` pairs, or `{value, observedAt}` instances).
pub fn series(entity: &Json, attr: &str) -> Vec<(f64, String)> {
    let values = match entity.get(attr) {
        Some(Json::Object(o)) => o
            .get("values")
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default(),
        Some(Json::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    values
        .iter()
        .filter_map(|entry| match entry {
            Json::Array(pair) if pair.len() >= 2 => {
                Some((number_of(&pair[0])?, pair[1].as_str()?.to_owned()))
            }
            Json::Object(o) => Some((
                number_of(o.get("value")?)?,
                o.get("observedAt")?.as_str()?.to_owned(),
            )),
            _ => None,
        })
        .collect()
}

/// The weather points of a station's temperature and precipitation, by time, as the browser joins them.
pub fn weather_points(entity: &Json) -> Vec<WeatherPointInput> {
    let mut by_time: std::collections::BTreeMap<String, (Option<f64>, Option<f64>)> =
        Default::default();
    for (value, at) in series(entity, "temperature") {
        by_time.entry(at).or_default().0 = Some(value);
    }
    for (value, at) in series(entity, "precipitation") {
        by_time.entry(at).or_default().1 = Some(value);
    }
    by_time
        .into_iter()
        .map(|(at, (temperature, precipitation))| WeatherPointInput {
            at,
            temperature,
            precipitation,
        })
        .collect()
}

fn read(path: &str) -> Result<Vec<Json>, Response> {
    gateway::get_json::<Vec<Json>>(path).map_err(Response::from)
}

/// The scalar the database answers for `statement`, as text.
fn scalar(statement: &str) -> Result<String, Response> {
    let rows = sql::query(statement, &[]).map_err(Response::from_sql)?;
    match rows.values.first().and_then(|row| row.first()) {
        Some(Value::Text(text)) => Ok(text.clone()),
        Some(Value::Int(n)) => Ok(n.to_string()),
        _ => Err(Response::problem(
            503,
            "Service Unavailable",
            "the database gave no answer",
        )),
    }
}

/// Trains today's model of `station` on its last seven days and keeps it with its training data.
fn train(station: &str) -> Result<(), Response> {
    let id = gateway::encode(station);
    let found = read(&format!(
        "/ngsi-ld/v1/entities?type=BikeHireDockingStation&id={id}&options=keyValues&attrs=location,totalSlotNumber"
    ))?;
    let Some(entity) = found.iter().find(|e| e["id"].as_str() == Some(station)) else {
        return Err(Response::problem(
            404,
            "Not Found",
            "the Endpoint holds no such station",
        ));
    };
    let total_slots = entity
        .get("totalSlotNumber")
        .and_then(number_of)
        .unwrap_or(0.0)
        .max(0.0) as usize;
    let since = scalar(
        r#"select to_char((now() - interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')"#,
    )?;
    let now: i64 = scalar("select extract(epoch from now())::bigint")?
        .parse()
        .unwrap_or_default();
    let day = scalar("select (now() at time zone 'Europe/Helsinki')::date::text")?;
    let history = read(&format!(
        "/ngsi-ld/v1/temporal/entities?type=BikeHireDockingStation&options=temporalValues&timerel=after&timeAt={}&id={id}&attrs=availableBikeNumber",
        gateway::encode(&since)
    ))?;
    let bikes: Vec<BikePointInput> = history
        .iter()
        .find(|e| e["id"].as_str() == Some(station))
        .map(|e| series(e, "availableBikeNumber"))
        .unwrap_or_default()
        .into_iter()
        .map(|(value, at)| BikePointInput { at, value })
        .collect();
    // A weather station that cannot be read leaves the model without its weather terms, as the
    // browser's estimate does.
    let weather_station = point_of(entity.get("location")).and_then(|at| {
        let stations = read(&format!(
            "/ngsi-ld/v1/entities?type=WeatherObserved&options=keyValues&attrs=location&limit={MOST_WEATHER}"
        ))
        .ok()?;
        nearest_weather(at, &stations)
    });
    let weather: Vec<WeatherPointInput> = match &weather_station {
        Some(w) => read(&format!(
            "/ngsi-ld/v1/temporal/entities?type=WeatherObserved&options=temporalValues&timerel=after&timeAt={}&id={}&attrs=temperature,precipitation",
            gateway::encode(&since),
            gateway::encode(w)
        ))
        .ok()
        .and_then(|list| list.into_iter().find(|e| e["id"].as_str() == Some(w.as_str())))
        .map(|e| weather_points(&e))
        .unwrap_or_default(),
        None => Vec::new(),
    };
    let snapshot = json!({
        "station": station, "weatherStation": weather_station, "trainedOn": day, "since": since, "totalSlots": total_slots,
        "bikes": bikes.iter().map(|b| json!({"at": b.at, "value": b.value})).collect::<Vec<_>>(),
        "weather": weather.iter().map(|w| json!({"at": w.at, "temperature": w.temperature, "precipitation": w.precipitation})).collect::<Vec<_>>(),
    });
    let output = run_estimate(&Input {
        now,
        total_slots,
        bikes,
        weather,
    });
    let key = snapshot_key(station, &day);
    blob::put(
        &key,
        snapshot.to_string().as_bytes(),
        Some("application/json"),
    )
    .map_err(Response::from_blob)?;
    sql::execute(
        "insert into station_models (station, trained_on, hours, enough, per_degree, rain, sigma, weather_station, profile, snapshot) \
         values ($1, $2::date, $3, $4, $5::float8, $6::float8, $7::float8, $8::text, $9::jsonb, $10) on conflict (station, trained_on) do nothing",
        &[
            Value::from(station),
            Value::from(day),
            Value::from(output.hours as i64),
            Value::from(output.enough),
            Value::from(output.weather.as_ref().map(|w| w.per_degree)),
            Value::from(output.weather.as_ref().map(|w| w.rain)),
            Value::from(output.sigma),
            Value::from(weather_station),
            Value::Json(serde_json::to_string(&output.profile).unwrap_or_else(|_| "[]".into())),
            Value::from(key),
        ],
    )
    .map(drop)
    .map_err(Response::from_sql)
}

fn models(request: &Request, _: &Params) -> Response {
    let station = match station_id(request.param("station")) {
        Ok(station) => station,
        Err(why) => return Response::problem(400, "Bad Request", &why),
    };
    let today = match sql::query(
        "select count(*) from station_models where station = $1 and trained_on = (now() at time zone 'Europe/Helsinki')::date",
        &[Value::from(station.as_str())],
    ) {
        Ok(rows) => !matches!(rows.values.first().and_then(|row| row.first()), Some(Value::Int(0)) | None),
        Err(err) => return Response::from_sql(err),
    };
    // A station the Endpoint does not hold is said; data that cannot be read leaves the kept
    // models readable, and says so.
    let problem = if today { None } else { train(&station).err() };
    if problem.as_ref().is_some_and(|answer| answer.status == 404) {
        return problem.unwrap_or_else(Response::no_content);
    }
    match sql::query(
        r#"select id, trained_on::text as trained_on, to_char(trained_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as trained_at,
                  hours, enough, per_degree, rain, sigma, weather_station
           from station_models where station = $1 order by trained_on desc limit $2"#,
        &[Value::from(station.as_str()), Value::from(MODELS)],
    ) {
        Ok(rows) if rows.values.is_empty() && problem.is_some() => {
            problem.unwrap_or_else(Response::no_content)
        }
        Ok(rows) => Response::json(
            200,
            &json!({ "models": sql::objects(&rows), "stale": problem.is_some() }),
        ),
        Err(err) => Response::from_sql(err),
    }
}

fn download(_: &Request, params: &Params) -> Response {
    let Ok(id) = params["id"].parse::<i64>() else {
        return Response::problem(404, "Not Found", "no such model");
    };
    match sql::query(
        "select snapshot from station_models where id = $1",
        &[Value::from(id)],
    ) {
        Ok(rows) => match rows.values.first().and_then(|row| row.first()) {
            Some(Value::Text(key)) => match blob::presign(key, Method::Get, URL_SECONDS) {
                Ok(url) => Response::json(200, &json!({ "url": url })),
                Err(err) => Response::from_blob(err),
            },
            _ => Response::problem(404, "Not Found", "no such model"),
        },
        Err(err) => Response::from_sql(err),
    }
}

pub fn handle(request: Request) -> Response {
    Router::new()
        .get("/api/models", models)
        .get("/api/models/{id}/snapshot", download)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_station_is_named_by_a_urn_and_nothing_else() {
        let ok = "urn:ngsi-ld:BikeHireDockingStation:hel.fi:helsinki:001";
        assert_eq!(station_id(Some(&format!(" {ok} "))), Ok(ok.to_owned()));
        for bad in [
            None,
            Some(""),
            Some("001"),
            Some("urn:a b"),
            Some("urn:a,urn:b"),
            Some("urn:../x/y"),
            Some("urn:a%2f"),
        ] {
            assert!(station_id(bad).is_err(), "{bad:?}");
        }
        assert!(station_id(Some(&format!("urn:{}", "x".repeat(300)))).is_err());
    }

    #[test]
    fn a_snapshot_key_is_safe_and_one_per_station_and_day() {
        let key = snapshot_key("urn:ngsi-ld:x:..:y", "2026-10-10");
        let hash = key
            .strip_prefix("training/2026-10-10/")
            .and_then(|k| k.strip_suffix(".json"))
            .unwrap_or_default();
        assert_eq!(hash.len(), 16);
        assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()), "{key}");
        assert_eq!(key, snapshot_key("urn:ngsi-ld:x:..:y", "2026-10-10"));
        assert_ne!(key, snapshot_key("urn:ngsi-ld:x:..:z", "2026-10-10"));
    }

    #[test]
    fn the_nearest_weather_station_within_ten_kilometres_is_picked() {
        let at = |lon: f64, lat: f64, id: &str| json!({"id": id, "location": {"type": "Point", "coordinates": [lon, lat]}});
        let stations = [
            at(24.95, 60.20, "far"),
            at(24.94, 60.17, "near"),
            at(25.50, 60.40, "too far"),
            json!({"id": "nowhere"}),
        ];
        assert_eq!(
            nearest_weather((24.941, 60.171), &stations).as_deref(),
            Some("near")
        );
        assert_eq!(nearest_weather((26.0, 61.0), &stations), None);
        assert!((haversine_km(24.94, 60.17, 24.94, 60.27) - 11.12).abs() < 0.05);
    }

    #[test]
    fn a_temporal_answer_is_read_in_both_shapes_and_weather_joined_by_time() {
        let pairs = json!({"id": "w", "temperature": {"type": "Property", "values": [[3.5, "2026-10-08T07:00:00Z"], ["4", "2026-10-08T08:00:00Z"], ["x", "2026-10-08T09:00:00Z"]]},
                           "precipitation": [{"value": 0.2, "observedAt": "2026-10-08T08:00:00Z"}]});
        assert_eq!(
            series(&pairs, "temperature"),
            [
                (3.5, "2026-10-08T07:00:00Z".to_owned()),
                (4.0, "2026-10-08T08:00:00Z".to_owned())
            ]
        );
        let points = weather_points(&pairs);
        assert_eq!(points.len(), 2);
        assert_eq!(
            (points[1].temperature, points[1].precipitation),
            (Some(4.0), Some(0.2))
        );
        assert_eq!(
            (points[0].temperature, points[0].precipitation),
            (Some(3.5), None)
        );
        assert!(series(&json!({}), "temperature").is_empty());
    }

    #[test]
    fn a_route_outside_the_api_or_without_a_station_is_answered_in_words() {
        let get = |path: &str| {
            handle(Request {
                method: "GET".into(),
                path: path.into(),
                ..Request::default()
            })
        };
        assert_eq!(get("/api/nothing").status, 404);
        let bare = get("/api/models");
        assert_eq!(bare.status, 400);
        assert!(String::from_utf8_lossy(&bare.body)
            .contains("?station=urn:ngsi-ld:BikeHireDockingStation"));
        assert_eq!(get("/api/models/x/snapshot").status, 404);
    }
}
