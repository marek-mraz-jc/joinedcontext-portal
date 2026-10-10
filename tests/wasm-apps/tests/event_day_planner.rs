//! event-day-planner's server on the host (T-3347): a day shared under a short code, planned from
//! the events the gateway gives with the caller's rights, its calendar file under the App's prefix,
//! and nothing of it reachable through a second App on the same component.

use serde_json::json;
use wasm_apps_harness::{fetch, Harness};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const EVENTS: &str = "/api/endpoint/fxqtz5wpwqicquej2ocrixp3cp/ngsi-ld/v1/entities";
const FAIR: &str = "urn:ngsi-ld:Event:helsinki:fair";
const TALK: &str = "urn:ngsi-ld:Event:helsinki:talk";
const LATER: &str = "urn:ngsi-ld:Event:helsinki:later";

#[tokio::test(flavor = "multi_thread")]
async fn a_shared_day_is_planned_from_the_gateway_kept_under_its_code_and_its_own() {
    let gateway = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(EVENTS))
        .and(query_param("id", format!("{FAIR},{TALK}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"id": FAIR, "type": "Event", "name": {"fi": "Messut", "en": "Fair, autumn"}, "address": "Messukeskus",
             "startDate": "2030-10-20T07:00:00Z", "endDate": "2030-10-20T15:00:00Z",
             "location": {"type": "Point", "coordinates": [24.94, 60.20]}},
            {"id": TALK, "type": "Event", "name": {"fi": "Puhe", "en": "Talk"},
             "startDate": "2030-10-20T09:00:00Z", "endDate": "2030-10-20T10:00:00Z",
             "location": {"type": "Point", "coordinates": [24.95, 60.17]}}
        ])))
        .mount(&gateway)
        .await;
    Mock::given(method("GET"))
        .and(path(EVENTS))
        .and(query_param("id", LATER))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"id": LATER, "type": "Event", "name": "Next week", "startDate": "2030-10-27T09:00:00Z"}
        ])))
        .mount(&gateway)
        .await;
    let h = Harness::new("event-day-planner", gateway).await;
    let share = |day: &str, ids: &[&str]| json!({"day": day, "ids": ids, "lang": "en"}).to_string();

    for (body, why) in [
        (share("2030-02-30", &[FAIR]), "no such day"),
        (share("2020-01-01", &[FAIR]), "a day that is over"),
        (share("2030-10-20", &[]), "nothing picked"),
        (
            share("2030-10-20", &["urn:ngsi-ld:Place:x"]),
            "not an event",
        ),
        (
            share("2030-10-20", &["urn:ngsi-ld:Event:a&type=Place"]),
            "a query smuggled in an id",
        ),
        (
            json!({"day": "2030-10-20", "ids": [FAIR], "lang": "de"}).to_string(),
            "a language the app has not",
        ),
        (
            json!({"day": "2030-10-20", "ids": [FAIR], "picks": []}).to_string(),
            "an unknown field",
        ),
    ] {
        assert_eq!(
            h.call(&h.first, "POST", "/api/itineraries", &body, None)
                .await
                .0,
            400,
            "{why}"
        );
    }
    assert_eq!(
        h.call(
            &h.first,
            "POST",
            "/api/itineraries",
            &share("2030-10-20", &[LATER]),
            None
        )
        .await
        .0,
        409,
        "not that day"
    );

    // An anonymous visitor shares the day: the public role reads, no token is made up.
    let (status, day) = h
        .call(
            &h.first,
            "POST",
            "/api/itineraries",
            &share("2030-10-20", &[FAIR, TALK]),
            None,
        )
        .await;
    assert_eq!(status, 201, "{day}");
    let code = day["code"].as_str().expect("a code").to_owned();
    assert!(
        code.len() == 12
            && code
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "{code}"
    );
    assert_eq!(day["picks"], json!(["fair", "talk"]));
    assert_eq!(day["items"].as_array().map(Vec::len), Some(2), "{day}");
    let seen = h.gateway.received_requests().await.unwrap_or_default();
    assert!(
        seen.iter()
            .all(|r| r.headers.get("authorization").is_none()),
        "no caller, no token"
    );

    let (status, shown) = h
        .call(
            &h.first,
            "GET",
            &format!("/api/itineraries/{code}"),
            "",
            None,
        )
        .await;
    assert_eq!(status, 200, "{shown}");
    assert_eq!(shown["day"], "2030-10-20");
    assert_eq!(shown["lang"], "en");
    assert_eq!(shown["picks"], json!(["fair", "talk"]));
    assert_eq!(shown["items"], day["items"]);

    let (status, link) = h
        .call(
            &h.first,
            "GET",
            &format!("/api/itineraries/{code}/ics"),
            "",
            None,
        )
        .await;
    assert_eq!(status, 200, "{link}");
    let (status, ics) = fetch(link["url"].as_str().expect("url")).await;
    assert_eq!(status, 200);
    assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"), "{ics}");
    assert!(ics.contains("SUMMARY:Fair\\, autumn\r\n"), "{ics}");
    assert!(ics.contains("LOCATION:Messukeskus\r\n"), "{ics}");

    // A second App on the same component, and codes that are no share.
    assert_eq!(
        h.call(
            &h.second,
            "GET",
            &format!("/api/itineraries/{code}"),
            "",
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        h.call(
            &h.second,
            "GET",
            &format!("/api/itineraries/{code}/ics"),
            "",
            None
        )
        .await
        .0,
        404
    );
    for wrong in ["ABCDEF123456", "abc", "zzzzzzzzzzzz"] {
        assert_eq!(
            h.call(
                &h.first,
                "GET",
                &format!("/api/itineraries/{wrong}"),
                "",
                None
            )
            .await
            .0,
            404,
            "{wrong}"
        );
    }
    assert_eq!(h.count(&h.first, "itineraries").await, 1);
    assert_eq!(h.count(&h.second, "itineraries").await, 0);
}
