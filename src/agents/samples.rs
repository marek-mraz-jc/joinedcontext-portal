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

/// The sample whose keywords the request names most, the first by name on a tie; none when the
/// request names none of them, and the template stands alone.
pub fn closest(request: &str) -> Option<Sample> {
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
    let (_, card) = ranked.into_iter().next()?;
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
