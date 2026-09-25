//! The gallery of sample applications (SDK-24, T-2778): a code run starts from the template and,
//! when the request reads like one of the samples (a map for residents, a desk, a dashboard of
//! indicators, a calendar, a form, a story, a live monitor), the pack carries that sample's
//! README and source as the example to adapt, so two requests of different kinds do not come
//! back in the same shape. The samples live in `sdk/samples/<name>/`, overlay the template's
//! paths, and are compiled into the binary like the template.

use std::collections::{BTreeMap, BTreeSet};

use rust_embed::RustEmbed;
use serde::Deserialize;

/// What the model reads of a sample: its README and its source, never its tests, fixtures or
/// look (the run's look is generated, `theme.rs`).
#[derive(RustEmbed)]
#[folder = "sdk/samples"]
#[include = "*/sample.json"]
#[include = "*/README.md"]
#[include = "*/src/*"]
#[exclude = "*.test.ts"]
#[exclude = "*.test.tsx"]
#[exclude = "*/src/fixtures.ts"]
#[exclude = "*/src/design-tokens.json"]
struct Gallery;

#[derive(Deserialize)]
struct Card {
    name: String,
    title: String,
    purpose: String,
    archetype: String,
    layout: String,
    keywords: Vec<String>,
}

/// One sample as the pack shows it.
pub struct Sample {
    pub name: String,
    pub title: String,
    pub purpose: String,
    /// Path under `sdk/samples/<name>/` and content, README first.
    pub files: Vec<(String, String)>,
}

fn cards() -> Vec<Card> {
    Gallery::iter()
        .filter(|path| path.ends_with("/sample.json"))
        .filter_map(|path| serde_json::from_slice::<Card>(&Gallery::get(&path)?.data).ok())
        .collect()
}

/// How many of a sample's keywords the request names: a word matches a whole word of the
/// request, a hyphenated one ("real-time", "whats-on") its words in a row.
fn score(card: &Card, words: &BTreeSet<String>, spaced: &str) -> usize {
    card.keywords
        .iter()
        .filter(|keyword| {
            if keyword.contains('-') {
                spaced.contains(&format!(" {} ", keyword.replace('-', " ")))
            } else {
                words.contains(keyword.as_str())
            }
        })
        .count()
}

/// The card whose keywords the request names most, the first by name on a tie.
fn closest_card(request: &str) -> Option<Card> {
    let lower = request.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let words: BTreeSet<String> = tokens.iter().map(|word| (*word).to_owned()).collect();
    let spaced = format!(" {} ", tokens.join(" "));
    let mut ranked: Vec<(usize, Card)> = cards()
        .into_iter()
        .map(|card| (score(&card, &words, &spaced), card))
        .filter(|(score, _)| *score > 0)
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    ranked.into_iter().next().map(|(_, card)| card)
}

/// The sample whose keywords the request names most, the first by name on a tie; none when the
/// request names none of them, and the template stands alone.
pub fn closest(request: &str) -> Option<Sample> {
    let card = closest_card(request)?;
    let prefix = format!("{}/", card.name);
    let mut files: BTreeMap<String, String> = Gallery::iter()
        .filter(|path| path.starts_with(&prefix) && !path.ends_with("/sample.json"))
        .filter_map(|path| {
            let file = Gallery::get(&path)?;
            Some((
                path.into_owned(),
                String::from_utf8_lossy(&file.data).into_owned(),
            ))
        })
        .collect();
    let readme = files.remove(&format!("{prefix}README.md"));
    Some(Sample {
        name: card.name,
        title: card.title,
        purpose: card.purpose,
        files: readme
            .map(|content| (format!("{prefix}README.md"), content))
            .into_iter()
            .chain(files)
            .collect(),
    })
}

/// What an App is built as besides its look (AP-137): the closest sample's archetype and layout,
/// or the template's own for a request of no kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Design {
    pub archetype: String,
    pub layout: String,
}

/// The template's design, for a request no sample is close to.
const TEMPLATE: &str = "template";

/// The design a request starts from: the same answer on every run, so another App's design is
/// read back from its request.
pub fn design(request: &str) -> Design {
    closest_card(request).map_or_else(
        || Design {
            archetype: TEMPLATE.to_owned(),
            layout: TEMPLATE.to_owned(),
        },
        |card| Design {
            archetype: card.archetype,
            layout: card.layout,
        },
    )
}

/// What the run tells the model when another App already has its design (AP-137).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advice {
    /// The App of the project with the same archetype and layout.
    pub twin: String,
    /// The gallery layout to use instead.
    pub layout: String,
}

/// The advice for an App of `design` among the project's `others` (App name and design): none
/// when no other App has both its archetype and its layout. The layout offered is the first by
/// name that no App of the project holds, or the least held one when every layout is taken,
/// never the App's own.
pub fn advice(design: &Design, others: &[(String, Design)]) -> Option<Advice> {
    let twin = others
        .iter()
        .filter(|(_, other)| other == design)
        .map(|(name, _)| name.clone())
        .min()?;
    let layouts: BTreeSet<String> = cards().into_iter().map(|card| card.layout).collect();
    let held = |layout: &str| {
        others
            .iter()
            .filter(|(_, other)| other.layout == layout)
            .count()
    };
    let layout = layouts
        .into_iter()
        .filter(|layout| *layout != design.layout)
        .min_by_key(|layout| held(layout))?;
    Some(Advice { twin, layout })
}

/// The lines the first instruction carries for [`Advice`]: which App shares the design and the
/// layout to use, with one sentence on the difference.
pub fn advice_section(design: &Design, advice: &Advice) -> String {
    format!(
        "\n\nNOTE ON THE LOOK: the App `{}` of this project is already a {} laid out as \
         `{}`. This App has a look of its own, but the same archetype and layout would still make \
         the two look alike: lay this App out as the gallery layout `{}` instead, keeping what \
         the request asks for, and say in one sentence of your answer how it differs from `{}`. \
         If the person asks for the same layout, follow the person.",
        advice.twin, design.archetype, design.layout, advice.layout, advice.twin
    )
}

/// The pack's section for the request's closest sample, or nothing when no sample is close.
pub fn section(request: &str) -> Option<String> {
    let sample = closest(request)?;
    let mut out = format!(
        "\n## THE CLOSEST SAMPLE\n\nThe request reads like the gallery's **{}** sample: {} Build \
         on its layout, states and patterns, adapted to the request, the data above and this \
         application's own look. Its types and attributes are the sample's, not this \
         application's: read the endpoint's data. Its files import the template's components \
         from the same paths as the files of the project.\n\n",
        sample.title, sample.purpose
    );
    for (path, content) in &sample.files {
        let fence = path.rsplit('.').next().unwrap_or("text");
        out.push_str(&format!("### samples/{path}\n```{fence}\n{content}\n```\n"));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(request: &str) -> Option<String> {
        closest(request).map(|sample| sample.name)
    }

    #[test]
    fn every_sample_is_embedded_with_its_readme_and_app_and_without_tests_fixtures_or_look() {
        let names: Vec<String> = cards().into_iter().map(|card| card.name).collect();
        assert!(names.len() >= 7, "{names:?}");
        for path in Gallery::iter() {
            assert!(!path.contains(".test."), "{path}");
            assert!(!path.ends_with("fixtures.ts"), "{path}");
            assert!(!path.ends_with("design-tokens.json"), "{path}");
            assert!(!path.contains("node_modules"), "{path}");
        }
        for name in &names {
            assert!(
                Gallery::get(&format!("{name}/README.md")).is_some(),
                "{name}"
            );
            assert!(
                Gallery::get(&format!("{name}/src/App.tsx")).is_some(),
                "{name}"
            );
        }
    }

    #[test]
    fn a_request_gets_the_sample_of_its_kind() {
        assert_eq!(
            name("A map where residents find the nearest bike station").as_deref(),
            Some("citizen-map")
        );
        assert_eq!(
            name("Dashboard of our KPIs against their targets").as_deref(),
            Some("kpi-dashboard")
        );
        assert_eq!(
            name("An events calendar with a week view").as_deref(),
            Some("calendar-timeline")
        );
        assert_eq!(
            name("A form where residents submit complaints").as_deref(),
            Some("form-workflow")
        );
        assert_eq!(
            name("Real-time monitoring of the sensors with alarms").as_deref(),
            Some("realtime-monitor")
        );
        assert_eq!(
            name("A queue of incidents for the dispatcher to triage").as_deref(),
            Some("operations-desk")
        );
        assert_eq!(
            name("A scrollytelling story about the air for the press").as_deref(),
            Some("data-story")
        );
    }

    #[test]
    fn a_request_of_no_kind_keeps_the_template_alone() {
        assert!(closest("Show the data").is_none());
        assert!(closest("").is_none());
        // A keyword inside another word is not the keyword.
        assert!(closest("mapping of formulas").is_none());
    }

    fn designed(name: &str, request: &str) -> (String, Design) {
        (name.to_owned(), design(request))
    }

    /// AP-137: a request's design is its closest sample's archetype and layout, the template's
    /// when no sample is close, and the same answer on every run.
    #[test]
    fn a_request_starts_from_its_samples_archetype_and_layout() {
        let map = design("A map where residents find the nearest bike station");
        assert_eq!(map.archetype, "citizen-map");
        assert_eq!(map.layout, "hero-map");
        assert_eq!(
            map,
            design("A map where residents find the nearest bike station")
        );
        let plain = design("Show the data");
        assert_eq!(
            (plain.archetype.as_str(), plain.layout.as_str()),
            ("template", "template")
        );
    }

    /// AP-137: another App of the same archetype and layout gets the new one a layout no App of
    /// the project holds, the first by name.
    #[test]
    fn a_twin_design_is_offered_a_layout_nobody_holds() {
        let request = "A map where residents find the nearest bike station";
        let others = vec![
            designed("stations", "Map of the bike stations near me"),
            designed("kpis", "Dashboard of our KPIs against their targets"),
        ];
        let advice = advice(&design(request), &others).expect("the map has a twin");
        assert_eq!(advice.twin, "stations");
        assert_ne!(advice.layout, "hero-map");
        assert_ne!(
            advice.layout, "dashboard-grid",
            "a layout another App holds is not offered"
        );
        let section = advice_section(&design(request), &advice);
        assert!(
            section.contains("`stations`") && section.contains(&advice.layout),
            "{section}"
        );
    }

    /// AP-137: Apps of other designs, and no Apps at all, need no advice.
    #[test]
    fn no_twin_no_advice() {
        let request = "An events calendar with a week view";
        assert_eq!(advice(&design(request), &[]), None);
        let others = vec![designed("stations", "Map of the bike stations near me")];
        assert_eq!(advice(&design(request), &others), None);
    }

    /// AP-137: when every gallery layout is held, the least held one other than the App's own is
    /// offered, so the advice never repeats the twin's layout.
    #[test]
    fn when_every_layout_is_taken_the_least_used_other_one_is_offered() {
        let mut others: Vec<(String, Design)> = cards()
            .into_iter()
            .map(|card| {
                (
                    card.name.clone(),
                    Design {
                        archetype: card.archetype,
                        layout: card.layout,
                    },
                )
            })
            .collect();
        // The map layout twice more: it is the most held, and the App's own.
        let map = design("A map where residents find the nearest bike station");
        others.push(("stations-2".to_owned(), map.clone()));
        others.push(("stations-3".to_owned(), map.clone()));
        let advice = advice(&map, &others).expect("a twin");
        assert_ne!(advice.layout, map.layout);
        assert_eq!(advice.twin, "citizen-map");
    }

    #[test]
    fn the_section_names_the_sample_and_carries_its_readme_first_then_its_source() {
        let text = section("an events calendar").expect("a sample");
        assert!(text.contains("**Calendar and timeline**"), "{text}");
        let readme = text
            .find("### samples/calendar-timeline/README.md")
            .expect("readme");
        let app = text
            .find("### samples/calendar-timeline/src/App.tsx")
            .expect("app");
        assert!(readme < app);
        assert!(text.contains("### samples/calendar-timeline/src/calendar.ts"));
        assert!(!text.contains("calendar.test.ts"));
        assert!(section("hello").is_none());
    }
}
