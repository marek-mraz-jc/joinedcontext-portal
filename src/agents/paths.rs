//! The assistant's paths (ADR-N-032, AG-87…AG-91, API/04 §8 "Paths"): the guided flows a person
//! picks in the empty assistant, each with a first step the Portal answers without the model and
//! the tools the flow needs, so the agent works inside the path and nowhere else.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One path, as the request and the `path` event spell it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Path {
    IntegratePipeline,
    UploadData,
    FindData,
    ShareData,
    BuildApp,
    BuildDashboard,
    CreateDataModel,
    DefineKpi,
}

/// The first step of a path: a question the Portal asks itself (AG-91).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstStep {
    pub question: &'static str,
    /// Fixed options; empty with a `pick` or for free text.
    pub options: &'static [StepOption],
    /// The kind of resources the options are, as `jc_ask` names it (`endpoints`, `spaces`).
    pub pick: Option<&'static str>,
    pub multiple: bool,
    /// The page the step works on, under `/projects/{project}`.
    pub page: Option<&'static str>,
    /// The step also takes a file dropped, or a feed's address (T-2694).
    pub file: bool,
    pub url: bool,
    /// The name the Portal knows the step's answer by, when it takes the next step itself.
    pub step: Option<&'static str>,
}

/// One fixed option of a first step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOption {
    pub value: &'static str,
    pub title: &'static str,
    /// What the option needs to exist, as a `pick` names it, and the reason it is disabled
    /// when the person may read none of it (UI-44).
    pub needs: Option<(&'static str, &'static str)>,
}

const fn option(value: &'static str, title: &'static str) -> StepOption {
    StepOption {
        value,
        title,
        needs: None,
    }
}

/// Where a pipeline's data comes from, besides a file or an address (T-2694).
const SOURCES: &[StepOption] = &[
    StepOption {
        needs: Some(("datasources", "This project has no data source yet.")),
        ..option("datasource", "A data source this project already has")
    },
    StepOption {
        needs: Some(("spaces", "This project has no context space yet.")),
        ..option("space", "A context space of this project")
    },
];

/// Where a data model starts.
const MODEL_STARTS: &[StepOption] = &[
    option("smart-data-model", "A Smart Data Model"),
    option("sample", "A sample file of my data"),
    option("blank", "Nothing, I describe it"),
];

/// What every path may call: the conversation's own tools and the ones that only read.
const EVERY_PATH: &[&str] = &[
    "jc_ask",
    "jc_ui_navigate",
    "jc_switch_path",
    "describe_tool",
    "search_catalog",
    "jc_catalog_search",
    "query_endpoint",
    "jc_resource_list",
    "jc_resource_get",
    "jc_draft_get",
    "jc_draft_list",
    "jc_change_list",
    "jc_activity_list",
];

impl Path {
    pub const ALL: [Path; 8] = [
        Path::IntegratePipeline,
        Path::UploadData,
        Path::FindData,
        Path::ShareData,
        Path::BuildApp,
        Path::BuildDashboard,
        Path::CreateDataModel,
        Path::DefineKpi,
    ];

    /// The id the request, the event and the pack use.
    pub fn id(self) -> &'static str {
        match self {
            Path::IntegratePipeline => "integrate-pipeline",
            Path::UploadData => "upload-data",
            Path::FindData => "find-data",
            Path::ShareData => "share-data",
            Path::BuildApp => "build-app",
            Path::BuildDashboard => "build-dashboard",
            Path::CreateDataModel => "create-data-model",
            Path::DefineKpi => "define-kpi",
        }
    }

    pub fn from_id(id: &str) -> Option<Path> {
        Path::ALL.into_iter().find(|path| path.id() == id)
    }

    /// The kind the path ends by proposing: a person who may not propose it cannot take the path
    /// (AG-87, UI-44). Finding data proposes nothing.
    pub fn proposes(self) -> Option<&'static str> {
        match self {
            Path::IntegratePipeline | Path::DefineKpi => Some("Pipeline"),
            Path::UploadData => Some("ContextSpace"),
            Path::FindData => None,
            Path::ShareData => Some("Endpoint"),
            Path::BuildApp => Some("App"),
            Path::BuildDashboard => Some("Dashboard"),
            Path::CreateDataModel => Some("DataModel"),
        }
    }

    /// What the path is for, in one line of the model's pack and of `choose_path`.
    pub fn goal(self) -> &'static str {
        match self {
            Path::IntegratePipeline => {
                "bring a feed, a file or an existing data source into a space with a pipeline"
            }
            Path::UploadData => "upload a file of data into a context space",
            Path::FindData => "find data the project has and answer from it, changing nothing",
            Path::ShareData => "share data through an endpoint with other projects or the public",
            Path::BuildApp => "build an application that reads the project's endpoints",
            Path::BuildDashboard => "draw a dashboard over an endpoint",
            Path::CreateDataModel => {
                "create a data model from a Smart Data Model, a sample file or nothing"
            }
            Path::DefineKpi => "define a key performance indicator computed from a space",
        }
    }

    /// The steps after the first question, as the model's pack gives them (T-2696): without
    /// them the model ended Share data on the endpoint's own page, never asking with whom.
    pub fn steps(self) -> &'static str {
        match self {
            Path::IntegratePipeline => {
                "where the data comes from and where it lands are asked by the Portal, which \
                 drafts a new space itself; landing in an existing space is yours: draft the \
                 pipeline with change_resource, test it with jc_pipeline_test and say its \
                 verdict; the pipeline form opens on the draft"
            }
            Path::UploadData => {
                "the space is answered; ask for the file if none came, pick its type or create \
                 one (ask when the file fits several), then open the import page on the space"
            }
            Path::FindData => {
                "ask what the person looks for when they have not said, search the catalog, \
                 offer the matches as a jc_ask with options, open the one chosen and answer \
                 from its data"
            }
            Path::ShareData => {
                "the endpoint to share is answered; next ask with whom, as options: projects \
                 of this organization, the whole organization, or the public (the public needs \
                 a publisher's approval, say so); then change_resource that Endpoint's \
                 audience and allowedProjects, which opens its form on the draft. Opening the \
                 endpoint's page is not the end of this path"
            }
            Path::BuildApp => "the endpoints are answered and the app builder opens on them",
            Path::BuildDashboard => {
                "the endpoint is answered; ask which charts or map, as options that fit its \
                 entity types; then change_resource the Dashboard with its layers (create), \
                 which opens the dashboard editor on the draft"
            }
            Path::CreateDataModel => {
                "where the model starts is answered: a Smart Data Model, ask which; a sample, \
                 ask for the file; nothing, ask the person to describe the entities; then \
                 change_resource the DataModel (create), which opens its form on the draft"
            }
            Path::DefineKpi => {
                "the space is answered; ask which measure, as options from its entity types; \
                 compute it with compute_kpi and show the number; when it should stay \
                 updated, draft_kpi_pipeline, which opens the pipeline form on the draft"
            }
        }
    }

    pub fn first_step(self) -> FirstStep {
        let free = |question| FirstStep {
            question,
            options: &[],
            pick: None,
            multiple: false,
            page: None,
            file: false,
            url: false,
            step: None,
        };
        match self {
            // A feed's address and a file are the step's own inputs, beside the options.
            Path::IntegratePipeline => FirstStep {
                options: SOURCES,
                file: true,
                url: true,
                step: Some("integrate-source"),
                ..free("Where does the data come from?")
            },
            Path::UploadData => FirstStep {
                pick: Some("spaces"),
                page: Some("import"),
                ..free("Which space should the data go into?")
            },
            Path::FindData => free("What are you looking for?"),
            Path::ShareData => FirstStep {
                pick: Some("endpoints"),
                ..free("Which data do you want to share?")
            },
            // The chosen endpoints open the app builder, where the person starts the run.
            Path::BuildApp => FirstStep {
                pick: Some("endpoints"),
                multiple: true,
                step: Some("build-app-endpoints"),
                ..free("Which endpoints should the app read?")
            },
            Path::BuildDashboard => FirstStep {
                pick: Some("endpoints"),
                ..free("Which endpoint should the dashboard draw?")
            },
            Path::CreateDataModel => FirstStep {
                options: MODEL_STARTS,
                page: Some("models"),
                ..free("Where does the model start?")
            },
            Path::DefineKpi => FirstStep {
                pick: Some("spaces"),
                ..free("Which space do you measure?")
            },
        }
    }

    /// The tools the path adds to [`EVERY_PATH`].
    fn own_tools(self) -> &'static [&'static str] {
        match self {
            Path::IntegratePipeline => &[
                "change_resource",
                "jc_datasource_check",
                "jc_pipeline_test",
                "jc_pipeline_metrics",
                "jc_manifest_dry_run",
                "jc_draft_put",
            ],
            Path::UploadData => &[
                "space_complete",
                "change_resource",
                "jc_manifest_dry_run",
                "jc_draft_put",
            ],
            Path::FindData => &[],
            Path::ShareData => &[
                "propose_endpoint",
                "edit_endpoint",
                "grant_role",
                "change_resource",
                "jc_manifest_dry_run",
            ],
            Path::BuildApp | Path::BuildDashboard | Path::CreateDataModel => {
                &["change_resource", "jc_manifest_dry_run", "jc_draft_put"]
            }
            Path::DefineKpi => &[
                "compute_kpi",
                "draft_kpi_pipeline",
                "jc_kpi_compute",
                "jc_pipeline_test",
                "change_resource",
            ],
        }
    }

    /// Whether a tool is the path's to call (AG-89); every other one is refused.
    pub fn allows(self, tool: &str) -> bool {
        EVERY_PATH.contains(&tool) || self.own_tools().contains(&tool)
    }

    /// Every tool of the path, in the order the pack lists them.
    pub fn tools(self) -> Vec<&'static str> {
        EVERY_PATH.iter().chain(self.own_tools()).copied().collect()
    }
}

/// The conversation's tools no path offers: an entity change is prepared on no path (AG-78).
const OFF_PATH_TOOLS: &[&str] = &["write_entities", "navigate"];

/// A tool of the conversation by its name, as the static name a metric may label a step with;
/// none for a name the model made up (T-2771).
pub fn known_tool(name: &str) -> Option<&'static str> {
    Path::ALL
        .iter()
        .flat_map(|path| path.tools())
        .chain(OFF_PATH_TOOLS.iter().copied())
        .find(|tool| *tool == name)
}

/// The paths as `choose_path` offers them to the model: one line each.
pub fn menu() -> String {
    Path::ALL
        .iter()
        .map(|path| format!("- {}: {}", path.id(), path.goal()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The path `choose_path`'s answer names: a JSON object `{"path": id | null, "reason": …}`
/// somewhere in the text. Anything else, or an id that is no path, is no path.
pub fn chosen(answer: &str) -> Option<(Path, String)> {
    let start = answer.find('{')?;
    let end = answer.rfind('}')?;
    let value: serde_json::Value = serde_json::from_str(answer.get(start..=end)?).ok()?;
    let path = Path::from_id(value.get("path")?.as_str()?)?;
    let reason = value
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();
    Some((path, reason))
}

/// The path a conversation's events leave it on: the last `path` event's.
pub fn last_of<'a>(
    events: impl IntoIterator<Item = &'a crate::agents::run::AgentRunEvent>,
) -> Option<Path> {
    events
        .into_iter()
        .filter(|event| event.kind == "path")
        .filter_map(|event| event.payload.get("path")?.as_str().and_then(Path::from_id))
        .last()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T-2696: the pack gives each path's steps, and each names the tool it ends with, which
    /// the path must allow; Share data asks with whom before anything opens.
    #[test]
    fn every_path_says_its_steps_with_tools_it_may_call() {
        for path in Path::ALL {
            let steps = path.steps();
            assert!(!steps.is_empty() && !steps.ends_with('.'), "{}", path.id());
            for word in steps.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
                if word.contains('_') {
                    assert!(path.allows(word), "{}: {word}", path.id());
                }
            }
        }
        let share = Path::ShareData.steps();
        assert!(
            share.find("with whom") < share.find("change_resource"),
            "{share}"
        );
    }

    #[test]
    fn every_path_has_an_id_that_reads_back_and_a_first_question() {
        for path in Path::ALL {
            assert_eq!(Path::from_id(path.id()), Some(path));
            assert_eq!(
                serde_json::to_value(path).expect("serializes"),
                serde_json::json!(path.id())
            );
            let step = path.first_step();
            assert!(step.question.ends_with('?'), "{}", path.id());
            assert!(
                step.options.is_empty() || step.pick.is_none(),
                "{}: a step offers its own options or a pick, not both",
                path.id()
            );
            assert!(
                !(step.multiple && (step.file || step.url)),
                "{}: a step that takes data takes one answer",
                path.id()
            );
            for option in step.options {
                if let Some((pick, reason)) = option.needs {
                    assert!(["datasources", "spaces"].contains(&pick), "{pick}");
                    assert!(reason.ends_with('.'), "{reason}");
                }
            }
        }
        assert_eq!(Path::from_id("delete-everything"), None);
        assert!(serde_json::from_value::<Path>(serde_json::json!("delete-everything")).is_err());
    }

    #[test]
    fn a_path_reads_everywhere_and_changes_only_what_it_is_for() {
        for path in Path::ALL {
            assert!(path.allows("jc_ask") && path.allows("query_endpoint"));
            assert!(path.allows("jc_switch_path"), "every path may hand over");
            assert!(!path.allows("jc_project_delete"), "{}", path.id());
            assert!(!path.allows("write_entities"), "{}", path.id());
        }
        assert!(
            !Path::FindData.allows("change_resource"),
            "finding data changes nothing"
        );
        assert!(Path::ShareData.allows("propose_endpoint"));
        assert!(!Path::BuildApp.allows("propose_endpoint"));
        assert!(Path::DefineKpi.allows("draft_kpi_pipeline"));
        assert!(!Path::IntegratePipeline.allows("grant_role"));
        assert_eq!(Path::FindData.proposes(), None);
        assert_eq!(Path::BuildApp.proposes(), Some("App"));
    }

    #[test]
    fn choose_path_reads_one_id_or_none() {
        assert_eq!(
            chosen("I think so.\n{\"path\": \"share-data\", \"reason\": \"they want to publish\"}"),
            Some((Path::ShareData, "they want to publish".to_owned()))
        );
        assert_eq!(chosen("{\"path\": null, \"reason\": \"a greeting\"}"), None);
        assert_eq!(chosen("{\"path\": \"rm-rf\"}"), None);
        assert_eq!(chosen("no json at all"), None);
        assert_eq!(chosen("}{"), None);
    }

    #[test]
    fn the_last_path_event_is_the_one_a_continuation_keeps() {
        let event = |kind: &str, path: &str| crate::agents::run::AgentRunEvent {
            run_id: "r".into(),
            seq: 0,
            kind: kind.into(),
            payload: serde_json::json!({ "path": path }),
            created_at: String::new(),
        };
        let events = [
            event("path", "find-data"),
            event("message", "build-app"),
            event("path", "share-data"),
            event("path", "not-a-path"),
        ];
        assert_eq!(last_of(&events), Some(Path::ShareData));
        assert_eq!(last_of(&events[1..2]), None);
    }

    #[test]
    fn the_menu_names_every_path_once() {
        let menu = menu();
        for path in Path::ALL {
            assert_eq!(menu.matches(&format!("- {}:", path.id())).count(), 1);
        }
    }
}
