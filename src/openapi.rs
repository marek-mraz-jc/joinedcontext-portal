use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use utoipa::openapi::schema::{Array, Ref, Schema};
use utoipa::openapi::RefOr;
use utoipa::{Modify, OpenApi};

use crate::activity::ActivityEvent;
use crate::agents::run::{AgentRun, AgentRunEvent, AgentRunStatus};
use crate::api::activity::{ActivityList, ExportLogsServiceResponse, PartialSuccess};
use crate::api::agent_runs::{
    AnswerRequest, CreateRunRequest, CreatedRun, EventReceipt, FailedRequest, MessageRequest,
    ObservedPage, PreviewErrorRequest, PreviewObservationRequest, RelayedEvent, RunContext,
    RunList,
};
use crate::api::assistant::{AgentAccessList, OperationAccess, ProfileAccess, StartConversation};
use crate::api::blueprints::FlowRequest;
use crate::api::catalogue::{
    CatalogueClass, CatalogueContact, CatalogueDataModel, CatalogueDataset, CatalogueDatasetDetail,
    CatalogueEndpoint, CatalogueFacetValue, CatalogueFacets, CatalogueLicence, CataloguePage,
    CataloguePublisher, CatalogueResource, CatalogueSample, CatalogueTemporal, CatalogueTheme,
};
use crate::api::changes::{ChangeAuthor, ChangeList, ChangeProposal, ChangeSummary};
use crate::api::ckan::{
    CkanStatus, DataStoreStatus, InstanceSummary, PublicationStatus, ResourceLink,
};
use crate::api::datamodels::{
    CatalogueEntry, ModelChange as DatamodelChange, OrganizationModel, OrganizationModels,
    SourceDryRunResult,
};
use crate::api::drafts::{DraftList, PutDraftRequest};
use crate::api::dry_run::DryRunResult;
use crate::api::export::{Revision, RevisionList};
use crate::api::federation::{Edge, EdgeKind, FederationGraph, Node, NodeHealth, RegistrationCard};
use crate::api::health::{Health, Readiness};
use crate::api::ops::{OperationAnnotations, OperationSummary};
use crate::api::pipelines::PipelineMetrics;
use crate::api::preferences::Preferences;
use crate::api::projects::{
    DuplicateProject, OpenProject, ProjectDetail, ProjectList, ProjectStatus, ProjectSummary, Usage,
};
use crate::api::resources::{ListMeta, ResourceList};
use crate::api::service_accounts::{KeyInfo, KeyList, MintedKey};
use crate::auth::oidc::{LogoutTarget, Me};
use crate::auth::{Front, Identity};
use crate::branding::Validation;
use crate::branding::{Branding, Colours, Fonts, Languages};
use crate::change::{Change, ChangeMeta, ChangePhase, ChangeStatus, Lane, PlanSummary};
use crate::error::ProblemDetails;
use crate::ops::drafts::{Draft, DraftEvent};
use crate::ops::verdict::{Finding, Level, Verdict};
use crate::permissions::{Affordance, Effective, Grant, ProjectAffordances};
use crate::plan::{FieldChange, PlanDiff};
use crate::reconciler::SyncStatus;
use crate::resource::{ResourceEnvelope, Status};
use crate::state::AppState;
use crate::tools::model_tools::{
    Artifacts, Catalogue, CatalogueModel, CatalogueSubject, GenerateRequest, ImportSdmRequest,
};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::openapi::openapi_json,
        crate::auth::oidc::login,
        crate::auth::oidc::callback,
        crate::auth::oidc::backchannel_logout,
        crate::api::assistant::get_catalog,
        crate::api::health::health,
        crate::api::health::ready,
        crate::api::branding::get_branding,
        crate::api::branding::get_asset,
        crate::auth::oidc::me,
        crate::auth::oidc::logout,
        crate::api::projects::list_projects,
        crate::api::projects::open_project,
        crate::api::projects::get_project,
        crate::api::projects::delete_project,
        crate::api::projects::duplicate_project,
        crate::api::resources::list,
        crate::api::resources::list_endpoints_everywhere,
        crate::api::blueprints::list_blueprints,
        crate::api::forms::list_forms,
        crate::api::blueprints::start_flow,
        crate::api::datamodels::list_organization_datamodels,
        crate::api::datamodels::get_source,
        crate::api::datamodels::put_source,
        crate::api::resources::get_resource,
        crate::api::pipelines::get_metrics,
        crate::api::pipelines::get_rejected,
        crate::api::pipelines::retry_rejected,
        crate::api::pipelines::get_runs,
        crate::api::pipelines::get_run_log,
        crate::api::export::export,
        crate::api::import::import,
        crate::api::export::revisions,
        crate::api::permissions::permissions_me,
        // The map of a generated application loads these two directly, without the typed
        // client, which is how they came to carry `utoipa::path` annotations and still be
        // absent from the document (T-2168). A route a person can call is in the contract.
        crate::api::basemap::get_style,
        crate::api::basemap::get_tile,
        crate::api::agent_runs::create_run,
        crate::api::agent_runs::list_runs,
        crate::api::agent_runs::get_run,
        crate::api::agent_runs::stream_events,
        crate::api::agent_runs::answer_question,
        crate::api::agent_runs::post_message,
        crate::api::agent_runs::post_preview_error,
        crate::api::agent_runs::post_preview_observation,
        crate::api::agent_runs::call_function,
        crate::api::agent_runs::cancel_run,
        crate::api::agent_runs::publish_run,
        crate::api::app_build::build,
        crate::api::app_build::rebuild,
        crate::api::app_me::me,
        crate::api::agent_runs::preview,
        crate::api::assistant::start_conversation,
        crate::api::assistant::get_access,
        crate::api::people::list_people,
        crate::api::people::create_person,
        crate::api::people::get_person,
        crate::api::people::edit_person,
        crate::api::people::disable_person,
        crate::api::people::enable_person,
        crate::api::people::reset_password,
        crate::api::people::remove_second_factor,
        crate::api::people::sign_out_person,
        crate::api::people::delete_person,
        crate::api::service_accounts::list_keys,
        crate::api::service_accounts::create_key,
        crate::api::service_accounts::rotate_key,
        crate::api::service_accounts::revoke_key,
        crate::api::preferences::get_preferences,
        crate::api::preferences::put_preferences,
        crate::api::ops::list_ops,
        crate::api::ops::run_op,
        crate::api::drafts::list_drafts,
        crate::api::drafts::get_draft,
        crate::api::drafts::put_draft,
        crate::api::drafts::drop_draft,
        crate::api::drafts::stream_draft_events,
        crate::api::activity::list_activity,
        crate::api::activity::stream_activity,
        crate::api::drift::list_drift,
        crate::api::drift::revert_drift,
        crate::api::drift::adopt_drift,
        crate::api::activity::ingest_activity,
        crate::api::mutate::create,
        crate::api::mutate::replace,
        crate::api::mutate::patch,
        crate::api::changes::list_changes,
        crate::api::ckan::get_status,
        crate::api::catalogue::get_catalogue,
        crate::api::catalogue::get_dataset,
        crate::api::catalogue::get_sample,
        crate::api::catalogue_draft::draft_publication,
        crate::api::federation::get_graph,
        crate::api::changes::get_change,
        crate::api::changes::approve_change,
        crate::api::changes::reject_change,
        crate::api::delete::delete_resource,
        crate::api::sync::get_sync_status,
        crate::api::sync_sources::status,
        crate::api::sync_sources::sync_now,
        crate::api::sync_sources::pause,
        crate::api::sync_sources::detach,
        crate::api::sync_sources::webhook,
        crate::api::workspaces::open_workspace,
        crate::api::workspaces::list_workspaces,
        crate::api::workspaces::get_workspace,
        crate::api::workspaces::compare_workspace,
        crate::api::workspaces::update_workspace,
        crate::api::workspaces::propose_workspace,
        crate::api::workspaces::discard_workspace,
        crate::api::workspaces::start_workspace_preview,
        crate::api::workspaces::get_workspace_preview,
        crate::api::workspaces::stop_workspace_preview,
        crate::api::webhook::gitea_webhook,
        crate::tools::model_tools::sdm_catalog,
        crate::tools::model_tools::generate,
        crate::tools::model_tools::import_sdm,
        crate::tools::model_tools::infer_schema,
        crate::api::pipeline_test::test_pipeline,
        crate::api::assistant::propose_endpoint,
        crate::mcp::handle_mcp,
    ),
    components(schemas(
        crate::api::app_build::AppBuild,
        crate::api::app_build::Rebuild,
        crate::api::app_me::AppMe,
        crate::git::WorkflowRun,
        AgentRun,
        AgentRunEvent,
        AgentRunStatus,
        CreateRunRequest,
        CreatedRun,
        StartConversation,
        AgentAccessList,
        ProfileAccess,
        OperationAccess,
        RunList,
        RunContext,
        RelayedEvent,
        EventReceipt,
        AnswerRequest,
        MessageRequest,
        PreviewErrorRequest,
        PreviewObservationRequest,
        ObservedPage,
        FailedRequest,
        Health,
        Readiness,
        Effective,
        Grant,
        Affordance,
        ProjectAffordances,
        Branding,
        Colours,
        Fonts,
        Languages,
        CkanStatus,
        CataloguePage,
        CatalogueDataset,
        CatalogueDatasetDetail,
        CataloguePublisher,
        CatalogueLicence,
        CatalogueFacets,
        CatalogueFacetValue,
        CatalogueTemporal,
        CatalogueContact,
        CatalogueResource,
        CatalogueEndpoint,
        CatalogueDataModel,
        CatalogueClass,
        CatalogueTheme,
        CatalogueSample,
        crate::api::catalogue_draft::CatalogueDraftRequest,
        crate::api::catalogue_draft::CatalogueDraft,
        InstanceSummary,
        PublicationStatus,
        ResourceLink,
        DataStoreStatus,
        FederationGraph,
        Node,
        NodeHealth,
        Edge,
        EdgeKind,
        RegistrationCard,
        Identity,
        Me,
        Front,
        LogoutTarget,
        ProblemDetails,
        ResourceEnvelope,
        crate::api::mutate::ResourceProposal,
        crate::api::import::ImportOptions,
        crate::ops::DraftRef,
        Status,
        ResourceList,
        ListMeta,
        DuplicateProject,
        OpenProject,
        ProjectDetail,
        ProjectStatus,
        Usage,
        ProjectList,
        ProjectSummary,
        Change,
        ChangeMeta,
        ChangeStatus,
        ChangePhase,
        crate::api::sync_sources::SyncSourceStatus,
        crate::api::sync_sources::SyncRunReport,
        crate::api::sync_sources::PauseRequest,
        crate::ops::workspaces::OpenRequest,
        crate::ops::previews::Preview,
        crate::ops::previews::PreviewEndpoint,
        crate::ops::workspaces::UpdateRequest,
        crate::ops::workspaces::Resolution,
        crate::ops::workspaces::UpdateReport,
        crate::ops::workspaces::WorkspaceView,
        crate::ops::workspaces::WorkspaceList,
        crate::ops::workspaces::Workspace,
        crate::ops::workspaces::Scope,
        crate::ops::workspaces::ScopedResource,
        crate::ops::workspaces::PreviewState,
        crate::ops::workspaces::Comparison,
        crate::ops::workspaces::FileConflict,
        crate::plan::FieldConflict,
        crate::plan::Side,
        crate::api::import::ImportReport,
        crate::api::import::ConflictPolicy,
        Lane,
        PlanSummary,
        PlanDiff,
        FieldChange,
        DryRunResult,
        SourceDryRunResult,
        OrganizationModels,
        OrganizationModel,
        CatalogueEntry,
        DatamodelChange,
        OperationSummary,
        OperationAnnotations,
        ChangeProposal,
        ChangeList,
        ChangeSummary,
        ChangeAuthor,
        SyncStatus,
        PipelineMetrics,
        crate::api::pipelines::RejectedPage,
        crate::api::pipelines::RetryRequest,
        crate::api::pipelines::RetryAnswer,
        crate::api::pipelines::RunList,
        crate::api::pipelines::LogPage,
        crate::pipeline_log::Run,
        crate::pipeline_log::LogLine,
        crate::pipeline_log::Outcome,
        crate::pipeline_outcomes::Rejected,
        GenerateRequest,
        ImportSdmRequest,
        Artifacts,
        Catalogue,
        CatalogueSubject,
        CatalogueModel,
        Preferences,
        KeyInfo,
        KeyList,
        MintedKey,
        Revision,
        RevisionList,
        FlowRequest,
        ActivityEvent,
        ActivityList,
        ExportLogsServiceResponse,
        PartialSuccess,
        Draft,
        DraftEvent,
        DraftList,
        PutDraftRequest,
        Verdict,
        Finding,
        Level,
        Validation,
    )),
    info(
        title = "joinedcontext Portal API",
        version = "0.1.0",
        description = "Administrative and platform management REST API for joinedcontext Portal"
    ),
    tags(
        (name = "system", description = "System operations"),
        (name = "auth", description = "Sign-in, sign-out and the current identity"),
        (name = "resources", description = "Resource operations"),
        (name = "people", description = "The people of the organization's realm (PF-90)"),
        (name = "permissions", description = "What the caller may do in a project (PF-50)"),
        (name = "tools", description = "Model Tools schema generation and preview"),
        (name = "ops", description = "One operation registry behind every door (AG-59, ADR-N-021)"),
        (name = "drafts", description = "Shared manifest drafts every window shares (AG-61, UI-47)"),
        (name = "preferences", description = "The signed-in person's own UI preferences"),
        (name = "access", description = "ServiceAccounts, their API keys and effective grants"),
        (name = "basemap", description = "Map tiles and styles for application views, proxied so no coordinate leaves the platform (AP-67)")
    ),
    modifiers(&JcCoreSchemas, &SharedRefusals)
)]
pub struct ApiDoc;

/// jc-core's types describe themselves with schemars, the Portal's with utoipa. The fields typed
/// by jc-core point at named components (so the generated TypeScript keeps `ObjectMeta`, `Phase`
/// and `Condition` as it always had them) and this modifier fills those components in from the
/// crate's own JSON Schema, so the document can never drift from the tagged contract.
struct JcCoreSchemas;

impl Modify for JcCoreSchemas {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.schemas.insert(
            "ObjectMeta".into(),
            schemars_schema::<jc_core::ObjectMeta>(),
        );
        components
            .schemas
            .insert("Phase".into(), schemars_schema::<jc_core::Phase>());
        components
            .schemas
            .insert("Condition".into(), schemars_schema::<jc_core::Condition>());
    }
}

/// The refusal every session write shares (PF-50, T-1656). The CSRF guard stands in front of
/// every write the API router mounts, and every write needs a verb the caller may lack, so each
/// one can answer `403` with the problem body whatever its own annotation lists. The
/// server-to-server doors sit outside the guard and answer for their own signatures, so they
/// keep what they document. An operation that documents its own `403` keeps its own wording.
struct SharedRefusals;

impl Modify for SharedRefusals {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::{ContentBuilder, ResponseBuilder};

        let forbidden = ResponseBuilder::new()
            .description(
                "Forbidden: the CSRF token is missing or does not match, or the caller lacks the \
                 verb this write needs",
            )
            .content(
                "application/json",
                ContentBuilder::new()
                    .schema(Some(Ref::from_schema_name("ProblemDetails")))
                    .build(),
            )
            .build();
        for (path, item) in openapi.paths.paths.iter_mut() {
            if path.starts_with("/api/v1/webhooks/") || path == "/api/v1/auth/backchannel-logout" {
                continue;
            }
            for operation in [
                item.post.as_mut(),
                item.put.as_mut(),
                item.patch.as_mut(),
                item.delete.as_mut(),
            ]
            .into_iter()
            .flatten()
            {
                operation
                    .responses
                    .responses
                    .entry("403".to_owned())
                    .or_insert_with(|| RefOr::T(forbidden.clone()));
            }
        }
    }
}

/// A jc-core type's draft-07 schema as a utoipa schema. Subschemas are inlined so no
/// `#/definitions/` reference is left pointing outside the OpenAPI components.
fn schemars_schema<T: schemars::JsonSchema>() -> RefOr<Schema> {
    let mut settings = schemars::gen::SchemaSettings::draft07();
    settings.inline_subschemas = true;
    let root = schemars::gen::SchemaGenerator::new(settings).into_root_schema_for::<T>();
    let value = serde_json::to_value(root.schema).unwrap_or_default();
    serde_json::from_value(value).unwrap_or_else(|err| {
        // A schema this crate cannot express is a build defect, not a runtime condition: the
        // openapi test catches it before it ships. Documented as a free object until then.
        tracing::error!(error = %err, "jc-core schema is not a valid OpenAPI schema");
        RefOr::T(Schema::Object(Default::default()))
    })
}

pub fn object_meta_ref() -> Ref {
    Ref::from_schema_name("ObjectMeta")
}

pub fn phase_ref() -> Ref {
    Ref::from_schema_name("Phase")
}

pub fn conditions_ref() -> Array {
    Array::new(Ref::from_schema_name("Condition"))
}

/// The document itself: a client that generates its types from the Portal fetches this, so it is
/// a path of the surface like any other (MF-11, T-2361).
#[utoipa::path(
    get,
    path = "/api/v1/openapi.json",
    tag = "meta",
    responses((status = 200, description = "The OpenAPI 3.1 document of this Portal"))
)]
pub async fn openapi_json() -> impl IntoResponse {
    Json(ApiDoc::openapi())
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/openapi.json", get(openapi_json))
}
