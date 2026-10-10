//! bike-rebalancing's server on the host (T-3346): a plan made from the gateway's stations with
//! the caller's token, kept in the App's schema with its route sheet under the App's prefix, a
//! drive recorded against it, and nothing of it visible to a second App on the same component.

use serde_json::json;
use wasm_apps_harness::{fetch, Harness};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const STATIONS: &str = "/api/endpoint/hveoejb7k3cedpvc7otakoozbe/ngsi-ld/v1/entities";

fn station(n: u32, name: &str, lon: f64, bikes: u32, capacity: u32) -> serde_json::Value {
    json!({"id": format!("urn:ngsi-ld:BikeHireDockingStation:{n:03}"), "type": "BikeHireDockingStation",
        "name": name, "location": {"type": "Point", "coordinates": [lon, 60.17]},
        "availableBikeNumber": bikes, "freeSlotNumber": capacity - bikes, "totalSlotNumber": capacity, "status": "working"})
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plan_is_made_from_the_gateway_kept_driven_and_its_own() {
    let gateway = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(STATIONS))
        .and(header("authorization", "Bearer tok-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            station(1, "Kamppi", 24.93, 20, 20),
            station(2, "Töölö, Hesperia", 24.92, 0, 20),
            station(3, "Kallio", 24.95, 10, 20),
        ])))
        .mount(&gateway)
        .await;
    Mock::given(method("GET"))
        .and(path(STATIONS))
        .respond_with(ResponseTemplate::new(401))
        .mount(&gateway)
        .await;
    let h = Harness::new("bike-rebalancing", gateway).await;
    let me = Some("tok-1");
    let new = r#"{"operator": " Van 1 ", "vanCapacity": 15}"#;

    // Without a valid login the gateway refuses, and the App passes that on.
    assert_eq!(
        h.call(&h.first, "POST", "/api/plans", new, None).await.0,
        401
    );
    assert_eq!(
        h.call(&h.first, "POST", "/api/plans", r#"{"operator": ""}"#, me)
            .await
            .0,
        400
    );
    assert_eq!(
        h.call(
            &h.first,
            "POST",
            "/api/plans",
            r#"{"operator": "x", "vanCapacity": 0}"#,
            me
        )
        .await
        .0,
        400
    );
    assert_eq!(
        h.call(
            &h.first,
            "POST",
            "/api/plans",
            r#"{"operator": "x", "colour": "red"}"#,
            me
        )
        .await
        .0,
        400,
        "an unknown field is refused"
    );
    assert_eq!(
        h.call(
            &h.first,
            "POST",
            "/api/plans",
            r#"{"operator": "x", "start": "urn:nowhere"}"#,
            me
        )
        .await
        .0,
        400
    );

    let (status, plan) = h.call(&h.first, "POST", "/api/plans", new, me).await;
    assert_eq!(status, 201, "{plan}");
    assert_eq!(plan["operator"], "Van 1");
    let id = plan["id"].as_i64().expect("an id");
    let stops = plan["stops"].as_array().expect("stops");
    assert_eq!(stops.len(), 2, "the full station and the empty one: {plan}");
    assert_eq!(stops[0]["action"], "pick");
    assert_eq!(plan["moved"], 10);

    let (_, list) = h
        .call(&h.first, "GET", "/api/plans?operator=Van%201", "", me)
        .await;
    assert_eq!(list[0]["id"], id);
    assert_eq!(list[0]["stopCount"], 2);
    let (_, none) = h
        .call(&h.first, "GET", "/api/plans?operator=Van%202", "", me)
        .await;
    assert_eq!(none, json!([]));

    let (status, sheet) = h
        .call(&h.first, "GET", &format!("/api/plans/{id}/sheet"), "", me)
        .await;
    assert_eq!(status, 200, "{sheet}");
    let (status, csv) = fetch(sheet["url"].as_str().expect("url")).await;
    assert_eq!(status, 200);
    assert!(
        csv.starts_with("# Van 1\nstop,station,name,action,bikes,load_after,leg_km\n"),
        "{csv}"
    );
    assert!(csv.contains(",\"Töölö, Hesperia\",leave,10,0,"), "{csv}");

    let drive =
        json!({"stops": [stops[0]["id"], stops[1]["id"]], "km": 2.4, "note": "rain"}).to_string();
    let (status, driven) = h
        .call(
            &h.first,
            "POST",
            &format!("/api/plans/{id}/drives"),
            &drive,
            me,
        )
        .await;
    assert_eq!(status, 201, "{driven}");
    let stray = r#"{"stops": ["urn:ngsi-ld:BikeHireDockingStation:003"]}"#;
    assert_eq!(
        h.call(
            &h.first,
            "POST",
            &format!("/api/plans/{id}/drives"),
            stray,
            me
        )
        .await
        .0,
        400,
        "not a stop of the plan"
    );
    let (_, shown) = h
        .call(&h.first, "GET", &format!("/api/plans/{id}"), "", me)
        .await;
    assert_eq!(shown["drives"].as_array().map(Vec::len), Some(1));
    assert_eq!(shown["drives"][0]["note"], "rain");
    assert!(shown.get("sheet").is_none(), "the key stays the App's");
    assert_eq!(h.count(&h.first, "plans").await, 1);

    // The same component as a second App: its own empty tables, and no way to the first one's plan.
    assert_eq!(
        h.call(&h.second, "GET", "/api/plans", "", me).await.1,
        json!([])
    );
    assert_eq!(
        h.call(&h.second, "GET", &format!("/api/plans/{id}"), "", me)
            .await
            .0,
        404
    );
    assert_eq!(
        h.call(&h.second, "GET", &format!("/api/plans/{id}/sheet"), "", me)
            .await
            .0,
        404
    );
    assert_eq!(
        h.call(&h.second, "DELETE", &format!("/api/plans/{id}"), "", me)
            .await
            .0,
        404
    );

    assert_eq!(
        h.call(&h.first, "DELETE", &format!("/api/plans/{id}"), "", me)
            .await
            .0,
        204
    );
    assert_eq!(
        h.call(&h.first, "GET", &format!("/api/plans/{id}"), "", me)
            .await
            .0,
        404
    );
    assert_eq!(
        h.count(&h.first, "drives").await,
        0,
        "its drives went with it"
    );
    assert_eq!(
        fetch(sheet["url"].as_str().expect("url")).await.0,
        404,
        "and its sheet"
    );
}
