//! The server of transit-reach (T-3349): HSL's stops and lines kept by version, and for each stop
//! the area reached in 10, 20 and 30 minutes on that version, with its hexagons as GeoJSON under
//! the App's own prefix. The page still answers a click anywhere in the browser at once; from a
//! stop, the server's answer is computed once per version of the network and kept, so it is the
//! same for every visitor and its file can be downloaded.
//!
//! | Route | What it does |
//! |---|---|
//! | `GET /api/network` | the version of the network kept, and whether it is due to be read again |
//! | `POST /api/network` | HSL's registers read again; a new version when they changed |
//! | `GET /api/reach?stop=` | the area reached from a stop in each band; a URL its GeoJSON downloads from |

use jc_app_sdk::blob::{self, Method};
use jc_app_sdk::gateway;
use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql::{self, Value};
use serde_json::{json, Value as Json};
use transit_reach::network::Network;
use transit_reach::{run, Input, LonLat, Output};

/// The bands the page shows, the wait at each boarding and the hexagons' size: the page's own.
const BANDS: [f64; 3] = [10.0, 20.0, 30.0];
const WAIT: f64 = 5.0;
const HEX: f64 = 150.0;
/// Rows read per page of a register, and the most pages, so an endpoint that never ends a list
/// cannot hold the request (the page reads the same way, src/network.ts).
const PAGE: usize = 1000;
const MAX_PAGES: usize = 20;
/// A network read longer ago than this is read again when the page asks.
const STALE_HOURS: i64 = 6;
/// Files of an older network deleted per refresh, so one request never does unbounded work.
const DELETE_AT_ONCE: usize = 200;
/// How long a download URL lives; the host allows at most 300 seconds.
const URL_SECONDS: u32 = 120;

/// A GtfsStop's id: its URN, of letters, digits and `._~:-`, at most 256 long.
pub fn stop_urn(id: &str) -> Result<&str, String> {
    let rest = id.strip_prefix("urn:ngsi-ld:GtfsStop:").unwrap_or_default();
    if rest.is_empty()
        || id.len() > 256
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._~:-".contains(c))
    {
        return Err(format!("{id} is not the id of an HSL stop"));
    }
    Ok(id)
}

/// The GTFS stop id that ends a GtfsStop's id, the id a line names its stops by.
pub fn gtfs_id(urn: &str) -> &str {
    urn.rsplit(':').next().unwrap_or(urn)
}

/// A stop id as one segment of a key: letters, digits, `.` and `-` kept, every other byte as
/// `_XX`, so two ids never share a key and none leaves its folder.
pub fn key_segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'.' && !out.is_empty() || byte == b'-' {
            out.push(byte as char);
        } else {
            out.push_str(&format!("_{byte:02X}"));
        }
    }
    out
}

fn value(entity: &Json, name: &str) -> Option<Json> {
    let v = entity.get(name)?;
    match v.get("value").or_else(|| v.get("languageMap")) {
        Some(inner) if v.get("type").is_some() => Some(inner.clone()),
        _ => Some(v.clone()),
    }
}

fn text(entity: &Json, name: &str) -> String {
    match value(entity, name) {
        Some(Json::String(s)) => s.trim().to_owned(),
        Some(Json::Number(n)) => n.to_string(),
        Some(Json::Object(map)) => ["fi", "en", "sv"]
            .iter()
            .find_map(|l| map.get(*l).and_then(Json::as_str))
            .or_else(|| map.values().find_map(Json::as_str))
            .unwrap_or_default()
            .trim()
            .to_owned(),
        _ => String::new(),
    }
}

/// The network of the registers' rows, as the page builds it (src/network.ts `toNetwork`): every
/// placed stop, every line with a number and at least two stops. Sorted, so the same registers
/// always give the same version.
pub fn network_of(stops: &[Json], routes: &[Json]) -> Json {
    let mut placed: Vec<Json> = stops
        .iter()
        .filter_map(|row| {
            let id = gtfs_id(row.get("id")?.as_str()?).to_owned();
            let at = value(row, "location")?;
            let c = at.get("coordinates")?.as_array()?;
            let (lon, lat) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
            let mut stop = json!({"id": id, "lon": lon, "lat": lat});
            for (field, attr) in [("name", "name"), ("code", "stopCode")] {
                let t = text(row, attr);
                if !t.is_empty() {
                    stop[field] = Json::from(t);
                }
            }
            Some(stop)
        })
        .collect();
    placed.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut lines: Vec<Json> = routes
        .iter()
        .filter_map(|row| {
            let name = text(row, "routeShortName");
            let sequence: Vec<String> = match value(row, "stopSequence") {
                Some(Json::Array(items)) => items
                    .iter()
                    .filter_map(|i| i.as_str().map(|s| s.trim().to_owned()))
                    .filter(|s| !s.is_empty())
                    .collect(),
                Some(Json::String(s)) => s
                    .split(',')
                    .map(|p| p.trim().to_owned())
                    .filter(|p| !p.is_empty())
                    .collect(),
                _ => Vec::new(),
            };
            if name.is_empty() || sequence.len() < 2 {
                return None;
            }
            let mut line = json!({"name": name, "stops": sequence});
            let mode = text(row, "transportMode");
            if !mode.is_empty() {
                line["mode"] = Json::from(mode);
            }
            Some(line)
        })
        .collect();
    lines.sort_by_key(|l| l.to_string());
    json!({"stops": placed, "routes": lines})
}

/// The cells reached as a GeoJSON FeatureCollection: one polygon per hexagon, its ring closed,
/// with the minutes it is reached in and its band.
pub fn geojson(output: &Output) -> Json {
    let features: Vec<Json> = output
        .cells
        .iter()
        .filter(|cell| cell.ring.len() >= 3)
        .map(|cell| {
            let mut ring = cell.ring.clone();
            if ring.first() != ring.last() {
                ring.push(ring[0]);
            }
            json!({"type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "properties": {"minutes": (cell.minutes * 10.0).round() / 10.0, "band": cell.band}})
        })
        .collect();
    json!({"type": "FeatureCollection", "features": features})
}

/// The gateway's answer read as `T`, or what the caller gets: their own 401 or 403 passes
/// through, anything else is the gateway's fault.
fn read<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, Response> {
    let answer = gateway::get(path).map_err(|why| Response::problem(502, "Bad Gateway", &why))?;
    answer.json().map_err(|why| match answer.status {
        401 => Response::problem(401, "Unauthorized", &why),
        403 => Response::problem(403, "Forbidden", &why),
        _ => Response::problem(502, "Bad Gateway", &why),
    })
}

fn all(kind: &str, attrs: &str) -> Result<Vec<Json>, Response> {
    let mut rows = Vec::new();
    for page in 0..MAX_PAGES {
        let path = format!(
            "/ngsi-ld/v1/entities?type={kind}&options=keyValues&attrs={}&limit={PAGE}&offset={}",
            gateway::encode(attrs),
            page * PAGE
        );
        let batch: Vec<Json> = read(&path)?;
        let n = batch.len();
        rows.extend(batch);
        if n < PAGE {
            break;
        }
    }
    Ok(rows)
}

/// The kept network: its version, sizes, and whether it is due to be read again.
fn current() -> Result<Option<serde_json::Map<String, Json>>, Response> {
    let rows = sql::query(
        &format!(
            "select version, stops, routes, read_at as \"readAt\", checked_at as \"checkedAt\", \
             checked_at < now() - interval '{STALE_HOURS} hours' as stale from networks order by read_at desc limit 1"
        ),
        &[],
    )
    .map_err(Response::from_sql)?;
    Ok(sql::objects(&rows).into_iter().next())
}

fn show_network(_: &Request, _: &Params) -> Response {
    match current() {
        Ok(Some(network)) => Response::json(200, &network),
        Ok(None) => Response::problem(
            404,
            "Not Found",
            "HSL's stops and lines have not been read yet; POST /api/network reads them",
        ),
        Err(answer) => answer,
    }
}

/// Deletes an older version's files, at most [`DELETE_AT_ONCE`]; its row goes once they are gone.
fn retire(version: &str) -> Result<bool, Response> {
    let keys = blob::list(&format!("tiles/{version}/")).map_err(Response::from_blob)?;
    for key in keys.iter().take(DELETE_AT_ONCE) {
        match blob::delete(key) {
            Ok(()) | Err(blob::Error::NotFound) => {}
            Err(err) => return Err(Response::from_blob(err)),
        }
    }
    if keys.len() > DELETE_AT_ONCE {
        return Ok(false);
    }
    match blob::delete(&format!("networks/{version}.json")) {
        Ok(()) | Err(blob::Error::NotFound) => {}
        Err(err) => return Err(Response::from_blob(err)),
    }
    sql::execute(
        "delete from networks where version = $1",
        &[Value::from(version)],
    )
    .map_err(Response::from_sql)?;
    Ok(true)
}

fn refresh(_: &Request, _: &Params) -> Response {
    let (stops, routes) = match (
        all("GtfsStop", "name,stopCode,location"),
        all("TransitRoute", "routeShortName,transportMode,stopSequence"),
    ) {
        (Ok(s), Ok(r)) => (s, r),
        (Err(answer), _) | (_, Err(answer)) => return answer,
    };
    let network = network_of(&stops, &routes);
    let (n_stops, n_routes) = (
        network["stops"].as_array().map_or(0, Vec::len),
        network["routes"].as_array().map_or(0, Vec::len),
    );
    if n_stops == 0 || n_routes == 0 {
        return Response::problem(409, "Conflict", "the space holds no HSL stops and lines to route over; the page uses the vehicles' history instead");
    }
    let text = network.to_string();
    let version = match sql::query(
        "select encode(sha256(convert_to($1, 'UTF8')), 'hex') as version",
        &[Value::from(text.as_str())],
    ) {
        Ok(rows) => match rows.values.first().and_then(|r| r.first()) {
            Some(Value::Text(v)) => v.clone(),
            _ => {
                return Response::problem(
                    500,
                    "Internal Server Error",
                    "the network's version was not computed",
                )
            }
        },
        Err(err) => return Response::from_sql(err),
    };
    let known = match sql::execute(
        "update networks set checked_at = now() where version = $1",
        &[Value::from(version.as_str())],
    ) {
        Ok(n) => n > 0,
        Err(err) => return Response::from_sql(err),
    };
    if !known {
        if let Err(err) = blob::put(
            &format!("networks/{version}.json"),
            text.as_bytes(),
            Some("application/json"),
        ) {
            return Response::from_blob(err);
        }
        if let Err(err) = sql::execute(
            "insert into networks (version, stops, routes) values ($1, $2, $3) on conflict (version) do update set checked_at = now()",
            &[Value::from(version.as_str()), Value::from(n_stops as i64), Value::from(n_routes as i64)],
        ) {
            return Response::from_sql(err);
        }
    }
    // Older versions go, their files first; what one request cannot delete, the next one does.
    let older = match sql::query(
        "select version from networks where version <> $1",
        &[Value::from(version.as_str())],
    ) {
        Ok(rows) => rows.values,
        Err(err) => return Response::from_sql(err),
    };
    for row in older {
        if let Some(Value::Text(old)) = row.first() {
            match retire(old) {
                Ok(true) => {}
                Ok(false) => break,
                Err(answer) => return answer,
            }
        }
    }
    Response::json(
        200,
        &json!({"version": version, "stops": n_stops, "routes": n_routes, "changed": !known}),
    )
}

fn reach(request: &Request, _: &Params) -> Response {
    let urn = match stop_urn(request.param("stop").unwrap_or_default()) {
        Ok(urn) => urn,
        Err(why) => return Response::problem(400, "Bad Request", &why),
    };
    let network = match current() {
        Ok(Some(network)) => network,
        Ok(None) => {
            return Response::problem(
                409,
                "Conflict",
                "HSL's stops and lines have not been read yet; POST /api/network reads them",
            )
        }
        Err(answer) => return answer,
    };
    let version = network
        .get("version")
        .and_then(Json::as_str)
        .unwrap_or_default()
        .to_owned();
    let stale = network
        .get("stale")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let answer = |bands: Json, tile: &str, cached: bool, name: Json, code: Json| match blob::presign(
        tile,
        Method::Get,
        URL_SECONDS,
    ) {
        Ok(url) => Response::json(
            200,
            &json!({"version": version, "stop": urn, "name": name, "code": code, "bands": bands, "cached": cached, "stale": stale, "url": url, "expiresIn": URL_SECONDS}),
        ),
        Err(err) => Response::from_blob(err),
    };
    match sql::query(
        "select bands, tile from reach where version = $1 and stop = $2",
        &[Value::from(version.as_str()), Value::from(urn)],
    ) {
        Ok(rows) => {
            if let Some(row) = sql::objects(&rows).into_iter().next() {
                let tile = row
                    .get("tile")
                    .and_then(Json::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let bands = row.get("bands").cloned().unwrap_or(Json::Null);
                return answer(bands, &tile, true, Json::Null, Json::Null);
            }
        }
        Err(err) => return Response::from_sql(err),
    }
    let bytes = match blob::get(&format!("networks/{version}.json")) {
        Ok(bytes) => bytes,
        Err(err) => return Response::from_blob(err),
    };
    let network: Network = match serde_json::from_slice(&bytes) {
        Ok(network) => network,
        Err(err) => {
            return Response::problem(
                500,
                "Internal Server Error",
                &format!("the kept network could not be read: {err}"),
            )
        }
    };
    let id = gtfs_id(urn);
    let Some(stop) = network.stops.iter().find(|s| s.id == id) else {
        return Response::problem(
            404,
            "Not Found",
            "HSL's network holds no such stop with a place",
        );
    };
    let (name, code) = (json!(stop.name), json!(stop.code));
    let output = match run(&Input {
        vehicles: Vec::new(),
        origin: LonLat {
            lon: stop.lon,
            lat: stop.lat,
        },
        network: Some(network),
        bands: BANDS.to_vec(),
        wait: WAIT,
        hex_size: HEX,
    }) {
        Ok(output) => output,
        Err(why) => return Response::problem(422, "Unprocessable Content", &why),
    };
    let tile = format!("tiles/{version}/{}.geojson", key_segment(id));
    if let Err(err) = blob::put(
        &tile,
        geojson(&output).to_string().as_bytes(),
        Some("application/geo+json"),
    ) {
        return Response::from_blob(err);
    }
    let bands = json!(output.bands);
    if let Err(err) = sql::execute(
        "insert into reach (version, stop, bands, tile) values ($1, $2, $3, $4) on conflict (version, stop) do nothing",
        &[Value::from(version.as_str()), Value::from(urn), Value::Json(bands.to_string()), Value::from(tile.as_str())],
    ) {
        return Response::from_sql(err);
    }
    answer(bands, &tile, false, name, code)
}

pub fn handle(request: Request) -> Response {
    Router::new()
        .get("/api/network", show_network)
        .post("/api/network", refresh)
        .get("/api/reach", reach)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_is_a_gtfs_stop_urn() {
        assert_eq!(
            stop_urn("urn:ngsi-ld:GtfsStop:HSL:1020453"),
            Ok("urn:ngsi-ld:GtfsStop:HSL:1020453")
        );
        for wrong in [
            "",
            "urn:ngsi-ld:GtfsStop:",
            "urn:ngsi-ld:Vehicle:1",
            "urn:ngsi-ld:GtfsStop:a,b",
            "urn:ngsi-ld:GtfsStop:a&b",
            "urn:ngsi-ld:GtfsStop:a/../b",
        ] {
            assert!(stop_urn(wrong).is_err(), "{wrong}");
        }
        assert_eq!(gtfs_id("urn:ngsi-ld:GtfsStop:HSL:1020453"), "1020453");
    }

    #[test]
    fn a_key_segment_never_leaves_its_folder_and_never_collides() {
        assert_eq!(key_segment("1020453"), "1020453");
        assert_eq!(key_segment("a/b"), "a_2Fb");
        assert_eq!(key_segment(".."), "_2E.");
        assert_eq!(
            key_segment("a_2Fb"),
            "a_5F2Fb",
            "an underscore is escaped too"
        );
        assert_ne!(key_segment("a/b"), key_segment("a_2Fb"));
        assert!(!key_segment("../x").contains('/'));
    }

    #[test]
    fn the_network_is_the_pages_and_the_same_registers_give_the_same_text() {
        let stops = vec![
            json!({"id": "urn:ngsi-ld:GtfsStop:HSL:2", "name": "Kamppi", "stopCode": "H1234", "location": {"type": "Point", "coordinates": [24.93, 60.17]}}),
            json!({"id": "urn:ngsi-ld:GtfsStop:HSL:1", "name": {"type": "Property", "value": "Rautatientori"}, "location": {"type": "GeoProperty", "value": {"type": "Point", "coordinates": [24.94, 60.17]}}}),
            json!({"id": "urn:ngsi-ld:GtfsStop:HSL:3", "name": "No place"}),
        ];
        let routes = vec![
            json!({"id": "r1", "routeShortName": "M1", "transportMode": "subway", "stopSequence": "1, 2"}),
            json!({"id": "r2", "routeShortName": 55, "stopSequence": ["2", "1"]}),
            json!({"id": "r3", "routeShortName": "X", "stopSequence": "1"}),
            json!({"id": "r4", "stopSequence": "1,2"}),
        ];
        let net = network_of(&stops, &routes);
        assert_eq!(
            net["stops"],
            json!([{"id": "1", "lon": 24.94, "lat": 60.17, "name": "Rautatientori"}, {"id": "2", "lon": 24.93, "lat": 60.17, "name": "Kamppi", "code": "H1234"}])
        );
        assert_eq!(net["routes"].as_array().map(Vec::len), Some(2), "{net}");
        let mut reversed = stops.clone();
        reversed.reverse();
        let mut routes_reversed = routes.clone();
        routes_reversed.reverse();
        assert_eq!(
            network_of(&reversed, &routes_reversed).to_string(),
            net.to_string()
        );
        let read: Network = serde_json::from_value(net).expect("the crate reads it");
        assert_eq!((read.stops.len(), read.routes.len()), (2, 2));
        assert_eq!(network_of(&[], &[]), json!({"stops": [], "routes": []}));
    }

    #[test]
    fn the_areas_are_closed_polygons_with_their_minutes() {
        let net: Network = serde_json::from_value(network_of(
            &[
                json!({"id": "urn:ngsi-ld:GtfsStop:HSL:1", "location": {"type": "Point", "coordinates": [24.94, 60.17]}}),
                json!({"id": "urn:ngsi-ld:GtfsStop:HSL:2", "location": {"type": "Point", "coordinates": [24.96, 60.19]}}),
            ],
            &[json!({"routeShortName": "M1", "transportMode": "subway", "stopSequence": "1,2"})],
        ))
        .expect("network");
        let output = run(&Input {
            vehicles: Vec::new(),
            origin: LonLat {
                lon: 24.94,
                lat: 60.17,
            },
            network: Some(net),
            bands: BANDS.to_vec(),
            wait: WAIT,
            hex_size: HEX,
        })
        .expect("reach");
        let gj = geojson(&output);
        let features = gj["features"].as_array().expect("features");
        assert!(!features.is_empty());
        for feature in features {
            let ring = feature["geometry"]["coordinates"][0]
                .as_array()
                .expect("ring");
            assert!(ring.len() >= 4);
            assert_eq!(ring.first(), ring.last(), "closed");
            let band = feature["properties"]["band"].as_f64().expect("band");
            assert!(BANDS.contains(&band));
            assert!(feature["properties"]["minutes"].as_f64().expect("minutes") <= band);
        }
    }
}
