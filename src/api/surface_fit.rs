//! `GET /api/v1/projects/{project}/spaces/{space}/surface-fit`: which domain-standard surfaces
//! the space's data model can serve, and why not (EP-125, T-5299). The Endpoint form greys out a
//! surface with a gap; the propose check (`mutate.rs` `check_surfaces`) refuses it with the same
//! sentence, from the same model.

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use jc_core::kinds::{DataModelLifecycle, DataModelSpec, Representation};
use serde::Serialize;
use utoipa::ToSchema;

use crate::auth::CurrentUser;
use crate::error::{ApiError, ProblemDetails};
use crate::state::AppState;

/// What one space's model serves of the surfaces that need a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceFit {
    /// The DataModel the surfaces are judged by, the one the form links to; none for a space
    /// without its own model.
    pub data_model: Option<String>,
    /// One row per representation that needs the model (`sta`, `ical`).
    pub surfaces: Vec<SurfaceGap>,
}

/// One representation and why the model cannot serve it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceGap {
    /// The representation's wire name, as `enabledRepresentations` lists it.
    #[schema(example = "sta")]
    pub representation: String,
    /// The sentence propose refuses it with; none when the model serves it. `ical` is judged by
    /// its mapping as well, which the form checks on save.
    #[schema(example = "`sta` needs a type with a numeric attribute that declares its unit")]
    pub gap: Option<String>,
}

/// The space's own model, a published version first: jcctl validate's choice (EP-125). Its
/// lifecycle and name; `None` for a space no valid model of its own names.
pub(crate) fn backing_model(
    state: &AppState,
    project: &str,
    space: &str,
) -> Option<(DataModelLifecycle, String)> {
    state
        .mirror
        .list(project, "DataModel", &crate::store::ListOptions::default())
        .items
        .into_iter()
        .filter_map(|model| {
            serde_json::from_value::<DataModelSpec>(model.spec)
                .ok()
                .filter(|m| {
                    m.context_space_ref.as_deref() == Some(space)
                        && m.lifecycle != DataModelLifecycle::Mirrored
                        && m.validate().is_ok()
                })
                .map(|m| (m.lifecycle, model.metadata.name))
        })
        .min_by_key(|(lifecycle, _)| !lifecycle.backs_surfaces())
}

/// Why `representation` cannot stand on a model in `lifecycle`: a draft can still change under a
/// public feed, a retired model takes no new references (DM-26).
pub(crate) fn lifecycle_gap(
    representation: Representation,
    space: &str,
    lifecycle: DataModelLifecycle,
) -> Option<String> {
    (!lifecycle.backs_surfaces()).then(|| {
        format!(
            "`{representation}` needs a published data model in space {space}; its model is {} (EP-125, DM-26)",
            lifecycle.as_str()
        )
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/projects/{project}/spaces/{space}/surface-fit",
    summary = "Read Surface Fit",
    description = "For each representation that needs the space's data model (SensorThings, iCalendar), the sentence an Endpoint listing it is refused with, or none when the model serves it. Reading the space is all it needs.",
    tag = "spaces",
    params(
        ("project" = String, Path, description = "Project name"),
        ("space" = String, Path, description = "Context Space name"),
    ),
    responses(
        (status = 200, description = "The surfaces and their gaps", body = SurfaceFit),
        (status = 401, description = "Not signed in", body = ProblemDetails),
        (status = 404, description = "No such space the caller may read", body = ProblemDetails),
    )
)]
pub async fn surface_fit(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((project, space)): Path<(String, String)>,
) -> Result<Json<SurfaceFit>, ApiError> {
    crate::api::data_views::readable_space(&state, &user.0.identity, &project, &space)?;
    let model = backing_model(&state, &project, &space);
    let linkml = match &model {
        Some((lifecycle, name)) if lifecycle.backs_surfaces() => {
            Some(crate::api::datamodels::read_source(&state, &project, name).await?)
        }
        _ => None,
    };
    let surfaces = Representation::ALL
        .into_iter()
        .filter(Representation::needs_model)
        .map(|representation| {
            let gap = match (&model, &linkml) {
                (Some((lifecycle, _)), None) => lifecycle_gap(representation, &space, *lifecycle),
                (_, Some(text)) => representation
                    .model_gap(text)
                    .unwrap_or_else(|err| Some(format!("the data model does not read: {err}")))
                    .map(|gap| format!("`{representation}` needs {gap}")),
                (None, None) => representation
                    .missing_model_gap()
                    .map(|gap| format!("`{representation}` needs {gap}")),
            };
            SurfaceGap {
                representation: representation.as_str().to_owned(),
                gap,
            }
        })
        .collect();
    Ok(Json(SurfaceFit {
        data_model: model.map(|(_, name)| name),
        surfaces,
    }))
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/{project}/spaces/{space}/surface-fit",
        get(surface_fit),
    )
}
