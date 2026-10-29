//! How a person reaches an Endpoint's data, as the registry's Endpoint read answers it (T-6027,
//! S-01, S-06, S-30, S-40): the entity types it serves, its address on the data host, one
//! address per representation its config serves, the embed code of a public one, and on request
//! who may write to it.

use serde_json::{json, Value};

use super::{Caller, OpError};
use crate::api::catalogue::{endpoint_url, served_representations};
use crate::resource::ResourceEnvelope;
use crate::state::AppState;
use crate::store::ListOptions;

/// The frame height the viz host's embed code uses when a site names none.
const EMBED_HEIGHT: u32 = 640;
/// The viz host's frame sandbox (`embed.js`), so a pasted frame reads as the Embed button's.
const EMBED_SANDBOX: &str =
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/// The types an Endpoint serves and its address: what a listing row carries.
pub(super) struct Reach {
    pub(super) types: Vec<String>,
    /// `https://api.{domain}/api/endpoint/{slug}/`; `None` before the Endpoint has a slug.
    pub(super) url: Option<String>,
}

/// The types and address of `endpoint`: the types its spec lists, else the classes of its
/// space's data model (`dataModelRef`, or the DataModels naming the space).
pub(super) fn reach(state: &AppState, project: &str, endpoint: &ResourceEnvelope) -> Reach {
    let spec = &endpoint.spec;
    let listed: Vec<String> = spec["entityTypes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_str().map(str::to_owned))
        .collect();
    let types = if listed.is_empty() {
        crate::resource::reference_name(&spec["contextSpaceRef"])
            .map(|space| space_classes(state, project, space))
            .unwrap_or_default()
    } else {
        listed
    };
    Reach {
        types,
        url: spec["slug"]
            .as_str()
            .map(|slug| endpoint_url(&state.config.api_base_url(), slug)),
    }
}

/// The classes of `space`'s data model: the one its `dataModelRef` names, else every DataModel
/// of the project whose `contextSpaceRef` is the space.
fn space_classes(state: &AppState, project: &str, space: &str) -> Vec<String> {
    let named = crate::api::assistant_context::model_classes(&state.mirror, project, space);
    if !named.is_empty() {
        return named;
    }
    let mut classes: Vec<String> = state
        .mirror
        .list(project, "DataModel", &ListOptions::default())
        .items
        .into_iter()
        .filter(|model| {
            crate::resource::reference_name(&model.spec["contextSpaceRef"]) == Some(space)
        })
        .flat_map(|model| {
            model.spec["classes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|class| class.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .collect();
    classes.sort();
    classes.dedup();
    classes
}

impl Reach {
    /// The Endpoint read's `access` member: the address, the types, one address per served
    /// representation (a representation the config does not serve is not offered), and the
    /// embed code when the Endpoint is public.
    pub(super) fn detail(self, state: &AppState, endpoint: &ResourceEnvelope) -> Value {
        let Some(url) = self.url else {
            return json!({ "types": self.types, "surfaces": [] });
        };
        let surfaces = surfaces(&endpoint.spec, &url, &self.types);
        let public = endpoint.spec["audience"].as_str() == Some("public");
        let embed = public
            .then(|| embed(state, endpoint, self.types.first().map(String::as_str)))
            .flatten();
        let mut access = json!({ "url": url, "types": self.types, "surfaces": surfaces });
        if let Some(embed) = embed {
            access["embed"] = json!(embed);
        }
        access
    }
}

/// One `{name, url}` per address of each representation `spec` serves under `url`.
fn surfaces(spec: &Value, url: &str, types: &[String]) -> Vec<Value> {
    let surface = |name: &str, at: String| json!({ "name": name, "url": at });
    let mut out = Vec::new();
    for served in served_representations(spec) {
        match served.as_str() {
            "ngsi-ld" => out.push(surface("ngsi-ld", format!("{url}ngsi-ld/v1/"))),
            "ogc-features" => {
                out.push(surface("ogc-features", format!("{url}ogc/features/")));
                // Each type is an OGC collection, whose items are GeoJSON.
                out.extend(types.iter().map(|t| {
                    surface(
                        "geojson",
                        format!("{url}ogc/features/collections/{}/items", encoded(t)),
                    )
                }));
            }
            "odata" => out.push(surface("odata", format!("{url}odata/v4/"))),
            "sta" => out.push(surface("sta", format!("{url}sta/v1.1"))),
            "csv" => out.push(surface("csv", format!("{url}file.csv"))),
            "websocket" => out.push(surface(
                "websocket",
                format!("{}ws", url.replacen("http", "ws", 1)),
            )),
            "mcp" => out.push(surface("mcp", format!("{url}mcp"))),
            _ => {}
        }
    }
    if let Ok(endpoint) = serde_json::from_value::<jc_core::kinds::EndpointSpec>(spec.clone()) {
        out.extend(
            jc_core::kinds::ical_links(endpoint.ical_outputs())
                .into_iter()
                .map(|(_, path)| surface("ical", format!("{url}{path}"))),
        );
    }
    let feeds: Vec<jc_core::kinds::FeedOutput> =
        serde_json::from_value(spec["representations"]["feed"].clone()).unwrap_or_default();
    out.extend(
        jc_core::kinds::feed_links(&feeds)
            .into_iter()
            .map(|(_, path, _, _)| surface("feed", format!("{url}{path}"))),
    );
    out
}

fn encoded(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// The viz host's frame for a public Endpoint (`embed.js` `snippet`, T-5129): it reads the
/// Endpoint anonymously, so it shows what any visitor may read. `None` when the Portal has no
/// `api.{domain}` data host, so no `viz.{domain}` beside it.
fn embed(
    state: &AppState,
    endpoint: &ResourceEnvelope,
    entity_type: Option<&str>,
) -> Option<String> {
    let api = state.config.api_base_url();
    let domain = api.host_str()?.strip_prefix("api.")?;
    let slug = endpoint.spec["slug"].as_str()?;
    let mut hash = slug.to_owned();
    if let Some(entity_type) = entity_type {
        hash.push_str(&format!("&type={}", encoded(entity_type)));
    }
    let name = endpoint.metadata.name.as_str();
    let title = endpoint.metadata.title.as_ref();
    let title: String = title
        .map_or(name, |title| title.resolve(&[], name))
        .chars()
        .take(200)
        .collect();
    Some(format!(
        "<iframe src=\"https://viz.{domain}/embed.html#{}\" title=\"{}\" width=\"100%\" \
         height=\"{EMBED_HEIGHT}\" style=\"border:0;max-width:100%\" loading=\"lazy\" \
         referrerpolicy=\"no-referrer\" sandbox=\"{EMBED_SANDBOX}\"></iframe>",
        attribute(&hash),
        attribute(&title)
    ))
}

/// `text` safe inside a double-quoted HTML attribute.
fn attribute(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Who may write to Endpoint `name`: each principal the gateway's PDP grants a write on one of
/// its types, with the types and the Policies that grant it. The access matrix decides who may
/// ask (an organization administrator or a reader of the space's Policies; anybody else is
/// refused) and records the read (EP-103), and its principals are only those the Policies of
/// this project's space name, so nobody outside the caller's project is listed.
pub(super) async fn writers(
    caller: &Caller,
    state: &AppState,
    project: &str,
    name: &str,
) -> Result<Value, OpError> {
    let axum::Json(matrix) = crate::api::access_matrix::access_matrix(
        super::runs::as_user(caller),
        axum::extract::State(state.clone()),
        axum::extract::Path((project.to_owned(), name.to_owned())),
        axum::extract::Query(crate::api::access_matrix::MatrixQuery { kind: None }),
    )
    .await?;
    let writers: Vec<Value> = matrix
        .principals
        .iter()
        .filter_map(|principal| {
            let id = format!("{}:{}", principal.kind, principal.name);
            let held = |effect: &str| -> Vec<&str> {
                matrix
                    .cells
                    .iter()
                    .filter(|c| c.principal == id && c.action == "write" && c.effect == effect)
                    .map(|c| c.entity_type.as_str())
                    .collect()
            };
            // A prohibition takes the write of its type away (ODRL, EP-103).
            let prohibited = held("prohibit");
            let types: Vec<&str> = held("permit")
                .into_iter()
                .filter(|t| !prohibited.contains(t) && !prohibited.contains(&"*"))
                .collect();
            (!types.is_empty()).then(|| {
                json!({
                    "kind": principal.kind,
                    "name": principal.name,
                    "types": types,
                    "via": principal.via.iter().map(|v| format!("{} {}", v.kind, v.name)).collect::<Vec<_>>(),
                })
            })
        })
        .collect();
    Ok(json!(writers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AppState {
        let mut config = crate::config::Config::for_tests();
        config.public_base_url = "https://portal.city.sk".parse().expect("url");
        AppState::new(config, None)
    }

    fn endpoint(spec: Value, title: Option<&str>) -> ResourceEnvelope {
        let mut envelope = ResourceEnvelope {
            api_version: crate::resource::API_VERSION.to_owned(),
            kind: "Endpoint".to_owned(),
            metadata: crate::resource::ObjectMeta::new("bikes", "doprava"),
            spec,
            status: None,
        };
        envelope.metadata.title = title.map(|t| jc_core::i18n::Text::Plain(t.to_owned()));
        envelope
    }

    #[test]
    fn an_endpoint_offers_only_the_representations_it_serves() {
        let state = state();
        let open = endpoint(
            json!({ "slug": "bikesdopravazzzzzzzzzzzzzzz", "entityTypes": ["Bike Counter"],
                    "audience": "public", "enabledRepresentations": ["csv", "ogc-features"] }),
            None,
        );
        let access = reach(&state, "doprava", &open).detail(&state, &open);
        let base = "https://api.city.sk/api/endpoint/bikesdopravazzzzzzzzzzzzzzz/";
        assert_eq!(access["url"], json!(base));
        let urls: Vec<&str> = access["surfaces"]
            .as_array()
            .expect("surfaces")
            .iter()
            .filter_map(|s| s["url"].as_str())
            .collect();
        assert!(
            urls.contains(&format!("{base}file.csv").as_str()),
            "{urls:?}"
        );
        assert!(
            urls.contains(&format!("{base}ogc/features/collections/Bike+Counter/items").as_str())
        );
        assert!(urls.contains(&format!("{base}ngsi-ld/v1/").as_str()));
        assert!(!urls.iter().any(|u| u.contains("odata")), "{urls:?}");
    }

    #[test]
    fn the_embed_code_escapes_the_title_and_is_only_for_a_public_endpoint() {
        let state = state();
        let spec = json!({ "slug": "bikesdopravazzzzzzzzzzzzzzz", "audience": "public",
                           "entityTypes": ["BikeCounter"] });
        let public = endpoint(spec.clone(), Some("\"><script>alert(1)</script>"));
        let access = reach(&state, "doprava", &public).detail(&state, &public);
        let embed = access["embed"].as_str().expect("embed");
        assert!(embed.starts_with(
            "<iframe src=\"https://viz.city.sk/embed.html#bikesdopravazzzzzzzzzzzzzzz&amp;type=BikeCounter\""
        ));
        assert!(
            embed.contains("title=\"&quot;&gt;&lt;script&gt;"),
            "{embed}"
        );
        assert!(!embed.contains("<script>"), "{embed}");
        let mut restricted = spec;
        restricted["audience"] = json!("restricted");
        let hidden = endpoint(restricted, None);
        let access = reach(&state, "doprava", &hidden).detail(&state, &hidden);
        assert!(access.get("embed").is_none(), "{access}");
    }

    #[tokio::test]
    async fn writers_are_refused_to_a_person_who_reads_no_policy() {
        let state = state();
        let caller = Caller {
            identity: crate::auth::session::Identity {
                client: None,
                subject: "sub-jana".into(),
                username: "jana".into(),
                email: None,
                name: None,
                roles: vec![],
                groups: vec![],
                second_factor: false,
            },
            via: super::super::Via::Mcp,
            access: None,
            bearer: None,
        };
        let refused = writers(&caller, &state, "doprava", "bikes")
            .await
            .expect_err("no Policy read");
        assert_eq!(
            refused.into_api_error().into_document().0,
            axum::http::StatusCode::FORBIDDEN
        );
    }
}
