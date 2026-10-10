//! The server half of data-quality-inspector (T-3354): what the browser cannot keep. The page
//! inspects the Endpoint's data as it is now; the server runs the same inspection (`../wasm`)
//! once a day, or when a reader asks, through the App's own Endpoint with the caller's token, and
//! keeps every run's scores in its own schema, so the page shows the trend. Each run's full report,
//! every finding of every entity, is a file under the App's prefix.
//!
//! | Route | What it does |
//! |---|---|
//! | `GET /api/runs` | the kept runs, newest first, each with its scores per type; a new run first when the newest is a day old |
//! | `POST /api/runs` | a run now, at most one every ten minutes |
//! | `GET /api/runs/{id}/report` | a URL to download the run's full per-entity report from |

use std::collections::BTreeMap;

use data_quality_inspector::{inspect_type_with, TypeInput, TypeOutput};
use jc_app_sdk::blob::{self, Method};
use jc_app_sdk::gateway;
use jc_app_sdk::http::{Params, Request, Response, Router};
use jc_app_sdk::sql::{self, Value};
use serde_json::{json, Map, Value as Json};

/// How long a presigned URL lives; the host allows at most 300 seconds.
const URL_SECONDS: u32 = 120;
/// Entities read per page, and at most per type.
const PAGE: usize = 500;
const MOST: usize = 5000;
/// Runs answered at most, for the trend.
const RUNS: i64 = 100;
/// The types the App's data need names, inspected without a schema when none is published.
const KNOWN_TYPES: [&str; 13] = [
    "AirQualityObserved",
    "Alert",
    "BikeHireDockingStation",
    "CityDistrict",
    "Event",
    "NewsArticle",
    "ParkingArea",
    "ParkingZone",
    "PointOfInterest",
    "PublicAreaPermit",
    "Vehicle",
    "WaterQualityObserved",
    "WeatherObserved",
];

/// A keyValues attribute as the browser's SDK reads it (`cell`): a DateTime's `@value`, a
/// language map's English or first text, a geometry as itself, a list as joined text.
pub fn cell(value: &Json) -> Json {
    match value {
        Json::Null | Json::Bool(_) | Json::Number(_) | Json::String(_) => value.clone(),
        Json::Array(items) => Json::String(
            items
                .iter()
                .map(|item| match cell(item) {
                    Json::String(text) => text,
                    Json::Null => String::new(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Json::Object(object) => {
            if let Some(inner) = object.get("@value") {
                return cell(inner);
            }
            if let Some(Json::Object(map)) = object.get("languageMap") {
                let picked = map.get("en").or_else(|| map.values().next());
                return picked.map_or(Json::Null, cell);
            }
            if object.get("type").is_some_and(Json::is_string) && object.contains_key("coordinates")
            {
                return json!({"type": object["type"], "coordinates": object["coordinates"]});
            }
            if let Some(inner) = object.get("value").or_else(|| object.get("object")) {
                return cell(inner);
            }
            match object.values().find(|v| v.is_string()) {
                Some(text) => text.clone(),
                None => Json::String(value.to_string()),
            }
        }
    }
}

/// An entity as the browser's row: every attribute through [`cell`], `@context` left out.
pub fn row(entity: &Json) -> Json {
    let mut row = Map::new();
    if let Some(object) = entity.as_object() {
        for (key, value) in object {
            if key != "@context" {
                row.insert(key.clone(), cell(value));
            }
        }
    }
    Json::Object(row)
}

/// The published schema's types and their definitions, as the browser's SDK merges them: every
/// model's `definitions` or `$defs`, only the types the index says are served, no `Entity`.
pub fn served_schema(index: &Json, documents: &[Json]) -> BTreeMap<String, Json> {
    let served: Vec<&str> = index["models"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| {
            m["types"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Json::as_str)
        })
        .collect();
    let mut merged = BTreeMap::new();
    for document in documents {
        for key in ["$defs", "definitions"] {
            if let Some(defs) = document.get(key).and_then(Json::as_object) {
                for (name, definition) in defs {
                    merged.insert(name.clone(), definition.clone());
                }
            }
        }
    }
    merged.retain(|name, definition| {
        name != "Entity"
            && (served.is_empty() || served.contains(&name.as_str()))
            && definition.get("properties").is_some()
    });
    merged
}

/// The run's scores over every type, weighted by the entities each holds; `valid` only over the
/// types with a published schema.
pub fn overall(types: &[TypeOutput]) -> (usize, usize, f64, Option<f64>) {
    let entities: usize = types.iter().map(|t| t.entities).sum();
    let findings: usize = types.iter().map(|t| t.findings_total).sum();
    let weighted = |pick: &dyn Fn(&TypeOutput) -> Option<f64>| {
        let (sum, n) = types
            .iter()
            .fold((0.0, 0usize), |(sum, n), t| match pick(t) {
                Some(score) if t.entities > 0 => (sum + score * t.entities as f64, n + t.entities),
                _ => (sum, n),
            });
        (n > 0).then(|| sum / n as f64)
    };
    let completeness = weighted(&|t| Some(t.completeness)).unwrap_or(0.0);
    (entities, findings, completeness, weighted(&|t| t.valid))
}

/// A run's full report: every type's findings grouped by the entity they are about.
pub fn report(types: &[TypeOutput]) -> Json {
    json!({
        "types": types.iter().map(|t| {
            let mut by_entity: BTreeMap<&str, Vec<Json>> = BTreeMap::new();
            for f in &t.findings {
                by_entity.entry(f.entity.as_str()).or_default().push(json!({"attribute": f.attribute, "rule": f.rule, "detail": f.detail}));
            }
            json!({
                "type": t.entity_type,
                "entities": t.entities,
                "completeness": t.completeness,
                "valid": t.valid,
                "attributes": t.attributes,
                "freshness": t.freshness,
                "findings": by_entity.into_iter().map(|(entity, findings)| json!({"entity": entity, "findings": findings})).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
    })
}

/// Every entity of `kind` the App's Endpoint lets the caller read, page by page, up to [`MOST`].
fn entities(kind: &str) -> Result<Vec<Json>, gateway::Error> {
    let mut all = Vec::new();
    loop {
        let path = format!(
            "/ngsi-ld/v1/entities?type={}&options=keyValues&limit={PAGE}&offset={}",
            gateway::encode(kind),
            all.len()
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

/// The Endpoint's published schema, or `None` when it publishes none the App can read.
fn schema() -> Option<BTreeMap<String, Json>> {
    let index: Json = gateway::get_json("/schema/index.json").ok()?;
    let mut versions: Vec<i64> = index["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["version"].as_i64())
        .collect();
    versions.sort_unstable();
    versions.dedup();
    if versions.is_empty() {
        versions.push(1);
    }
    let documents: Vec<Json> = versions
        .iter()
        .filter_map(|v| gateway::get_json(&format!("/schema/v{v}/json-schema")).ok())
        .collect();
    let schema = served_schema(&index, &documents);
    (!schema.is_empty()).then_some(schema)
}

/// One run now: every type read and inspected, its scores kept, its full report written.
fn inspect() -> Result<i64, Response> {
    let schema = schema();
    let names: Vec<String> = match &schema {
        Some(schema) => schema.keys().cloned().collect(),
        None => KNOWN_TYPES.iter().map(|t| (*t).to_owned()).collect(),
    };
    let now = sql::query("select extract(epoch from now())::float8", &[])
        .ok()
        .and_then(
            |rows| match rows.values.first().and_then(|row| row.first()) {
                Some(Value::Float(now)) => Some(*now),
                _ => None,
            },
        )
        .ok_or_else(|| {
            Response::problem(
                503,
                "Service Unavailable",
                "the database did not say what time it is",
            )
        })?;
    let mut types = Vec::new();
    for name in names {
        let rows = entities(&name)
            .map_err(|err| refused(&name, err))?
            .iter()
            .map(row)
            .collect();
        let input = TypeInput {
            entity_type: name.clone(),
            schema: schema.as_ref().and_then(|s| s.get(&name).cloned()),
            rows,
        };
        types.push(inspect_type_with(now, &input, usize::MAX));
    }
    let (entities, findings, completeness, valid) = overall(&types);
    let rows = sql::query(
        "insert into quality_runs (types, entities, findings, completeness, valid) values ($1, $2, $3, $4, $5::float8) returning id",
        &[
            Value::from(types.len() as i64),
            Value::from(entities as i64),
            Value::from(findings as i64),
            Value::from(completeness),
            Value::from(valid),
        ],
    )
    .map_err(Response::from_sql)?;
    let Some(Value::Int(id)) = rows.values.first().and_then(|row| row.first()).cloned() else {
        return Err(Response::problem(
            500,
            "Internal Server Error",
            "the run was not given an id",
        ));
    };
    for t in &types {
        sql::execute(
            "insert into run_types (run_id, type, entities, completeness, valid, findings, freshness_median_seconds) \
             values ($1, $2, $3, $4, $5::float8, $6, $7::float8)",
            &[
                Value::from(id),
                Value::from(t.entity_type.clone()),
                Value::from(t.entities as i64),
                Value::from(t.completeness),
                Value::from(t.valid),
                Value::from(t.findings_total as i64),
                Value::from(t.freshness.as_ref().map(|f| f.median_seconds)),
            ],
        )
        .map_err(Response::from_sql)?;
    }
    blob::put(
        &report_key(id),
        report(&types).to_string().as_bytes(),
        Some("application/json"),
    )
    .map_err(Response::from_blob)?;
    Ok(id)
}

fn report_key(id: i64) -> String {
    format!("runs/{id}/report.json")
}

/// Whether the newest run is younger than `interval` (a Postgres interval), or there is one at all.
fn ran_within(interval: &str) -> Result<bool, Response> {
    let rows = sql::query(
        "select count(*) from quality_runs where ran_at > now() - $1::interval",
        &[Value::from(interval)],
    )
    .map_err(Response::from_sql)?;
    Ok(!matches!(
        rows.values.first().and_then(|row| row.first()),
        Some(Value::Int(0)) | None
    ))
}

fn runs(_: &Request, _: &Params) -> Response {
    // A day without a run gets one, so the trend has a point a day; a feed that cannot be read
    // leaves the kept runs readable, and says so.
    let problem = match ran_within("1 day") {
        Ok(true) => None,
        Ok(false) => inspect().err(),
        Err(answer) => return answer,
    };
    let runs = match sql::query(
        r#"select id, to_char(ran_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ran_at, types, entities, findings,
                  completeness::float8 as completeness, valid::float8 as valid
           from quality_runs order by id desc limit $1"#,
        &[Value::from(RUNS)],
    ) {
        Ok(rows) => sql::objects(&rows),
        Err(err) => return Response::from_sql(err),
    };
    if runs.is_empty() {
        if let Some(problem) = problem {
            return problem;
        }
    }
    let types = match sql::query(
        "select run_id, type, entities, completeness::float8 as completeness, valid::float8 as valid, findings, freshness_median_seconds \
         from run_types where run_id in (select id from quality_runs order by id desc limit $1) order by run_id desc, type",
        &[Value::from(RUNS)],
    ) {
        Ok(rows) => sql::objects(&rows),
        Err(err) => return Response::from_sql(err),
    };
    let mut by_run: BTreeMap<i64, Vec<Json>> = BTreeMap::new();
    for mut t in types {
        let run = t
            .remove("run_id")
            .and_then(|r| r.as_i64())
            .unwrap_or_default();
        by_run.entry(run).or_default().push(Json::Object(t));
    }
    let runs: Vec<Json> = runs
        .into_iter()
        .map(|mut run| {
            let id = run.get("id").and_then(Json::as_i64).unwrap_or_default();
            run.insert(
                "types".into(),
                Json::Array(by_run.remove(&id).unwrap_or_default()),
            );
            Json::Object(run)
        })
        .collect();
    Response::json(200, &json!({ "runs": runs, "stale": problem.is_some() }))
}

fn run_now(_: &Request, _: &Params) -> Response {
    match ran_within("10 minutes") {
        Ok(true) => Response::problem(
            429,
            "Too Many Requests",
            "a run finished less than ten minutes ago; its scores are the newest",
        ),
        Ok(false) => match inspect() {
            Ok(id) => Response::json(201, &json!({ "id": id })),
            Err(answer) => answer,
        },
        Err(answer) => answer,
    }
}

fn download(_: &Request, params: &Params) -> Response {
    let Ok(id) = params["id"].parse::<i64>() else {
        return Response::problem(404, "Not Found", "no such run");
    };
    match sql::query(
        "select 1 from quality_runs where id = $1",
        &[Value::from(id)],
    ) {
        Ok(rows) if rows.values.is_empty() => Response::problem(404, "Not Found", "no such run"),
        Ok(_) => match blob::presign(&report_key(id), Method::Get, URL_SECONDS) {
            Ok(url) => Response::json(200, &json!({ "url": url })),
            Err(err) => Response::from_blob(err),
        },
        Err(err) => Response::from_sql(err),
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
        .get("/api/runs", runs)
        .post("/api/runs", run_now)
        .get("/api/runs/{id}/report", download)
        .handle(&request)
}

jc_app_sdk::app!(handle);

#[cfg(test)]
mod tests {
    use super::*;
    use data_quality_inspector::Finding;

    #[test]
    fn a_cell_is_read_as_the_browser_reads_it() {
        assert_eq!(
            cell(&json!({"@type": "DateTime", "@value": "2026-10-08T07:00:00Z"})),
            json!("2026-10-08T07:00:00Z")
        );
        assert_eq!(
            cell(&json!({"languageMap": {"fi": "Kirjasto", "en": "Library"}})),
            json!("Library")
        );
        assert_eq!(
            cell(&json!({"languageMap": {"fi": "Kirjasto"}})),
            json!("Kirjasto")
        );
        assert_eq!(
            cell(&json!({"type": "Point", "coordinates": [24.9, 60.1], "extra": 1})),
            json!({"type": "Point", "coordinates": [24.9, 60.1]})
        );
        assert_eq!(
            cell(&json!({"object": "urn:ngsi-ld:CityDistrict:x"})),
            json!("urn:ngsi-ld:CityDistrict:x")
        );
        assert_eq!(cell(&json!(["a", 1, null])), json!("a, 1, "));
        assert_eq!(cell(&json!({"n": 1})), json!("{\"n\":1}"));
        assert_eq!(cell(&json!(4.5)), json!(4.5));
        let r = row(&json!({"@context": "x", "id": "urn:a", "name": {"languageMap": {"en": "A"}}}));
        assert_eq!(r, json!({"id": "urn:a", "name": "A"}));
    }

    #[test]
    fn the_schema_is_merged_as_the_sdk_merges_it() {
        let index = json!({"models": [{"version": 1, "types": ["Alert", "Event"]}]});
        let documents = [
            json!({"definitions": {"Entity": {"properties": {}}, "Alert": {"properties": {"name": {}}}, "Vehicle": {"properties": {}}}}),
            json!({"$defs": {"Event": {"properties": {"startDate": {}}}, "Hidden": {"type": "object"}}}),
        ];
        let merged = served_schema(&index, &documents);
        assert_eq!(merged.keys().collect::<Vec<_>>(), ["Alert", "Event"]);
        assert!(served_schema(&json!({}), &[]).is_empty());
    }

    fn output(
        name: &str,
        entities: usize,
        completeness: f64,
        valid: Option<f64>,
        findings: Vec<Finding>,
    ) -> TypeOutput {
        TypeOutput {
            entity_type: name.into(),
            entities,
            completeness,
            valid,
            attributes: vec![],
            findings_total: findings.len(),
            findings,
            freshness: None,
        }
    }

    fn finding(entity: &str, attribute: &str) -> Finding {
        Finding {
            entity: entity.into(),
            attribute: attribute.into(),
            rule: "type".into(),
            detail: "not a number".into(),
        }
    }

    #[test]
    fn a_runs_scores_are_weighted_by_entities_and_valid_only_where_a_schema_is() {
        let types = [
            output(
                "Alert",
                3,
                1.0,
                Some(0.5),
                vec![finding("a1", "x"), finding("a1", "y"), finding("a2", "x")],
            ),
            output("Event", 1, 0.0, None, vec![]),
            output("Empty", 0, 0.0, Some(0.0), vec![]),
        ];
        let (entities, findings, completeness, valid) = overall(&types);
        assert_eq!((entities, findings), (4, 3));
        assert!((completeness - 0.75).abs() < 1e-9);
        assert_eq!(valid, Some(0.5));
        assert_eq!(overall(&[]), (0, 0, 0.0, None));
        let full = report(&types);
        assert_eq!(
            full["types"][0]["findings"][0],
            json!({"entity": "a1", "findings": [
            {"attribute": "x", "rule": "type", "detail": "not a number"}, {"attribute": "y", "rule": "type", "detail": "not a number"}]})
        );
        assert_eq!(
            full["types"][0]["findings"].as_array().map(Vec::len),
            Some(2)
        );
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
        assert_eq!(get("/api/runs/abc/report").status, 404);
        let wrong = handle(Request {
            method: "DELETE".into(),
            path: "/api/runs".into(),
            ..Request::default()
        });
        assert_eq!(wrong.status, 405);
    }
}
