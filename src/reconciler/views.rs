//! The broker's views and policy rule documents, written from the repository (T-3640; Antares
//! `docs/analysis/platform-switch-plan.md` sections 2.1, 2.2, 3.3 and 5.1).
//!
//! Every Endpoint becomes the view `{slug}` and every Context Space the view `cs-{segment}`
//! (`PUT /q/views/{id}`); every Context Space's Policies become the rule document of its tenant
//! (`PUT /q/policy/{tenant}`), which the broker's `joinedcontext` engine decides with; every
//! Context Space's data model becomes its tenant's schema (`PUT /q/schemas/{tenant}`, T-3703),
//! the `brokerSchema` Model Tools compiles from it and its imports. A view is
//! the widest an Endpoint ever shows: its projection's classes and slots, else what its Policies
//! name, less its hidden Attributes, with the operations its Policies grant. Who sees how much
//! of that is the engine's.
//!
//! Three rules:
//!
//! - the writer owns the ids an Endpoint slug can be (`^[a-z2-7]{26,63}$`) and the ids starting
//!   with `cs-`; a view written by hand under any other id is never deleted;
//! - an Endpoint the view cannot express is not written and its status says why: a slug over 63
//!   characters, over 256 types, hidden Attributes on a type shown whole, a `viewMappingRef` whose Mapping has no usable IR. It
//!   stays on the gateway path;
//! - the broker's admin token is read from the file its Secret is mounted at, on every run, and
//!   travels only in the `Authorization` header: never in a log, a status or an outcome.

use jc_core::envelope::ORG_NAMESPACE;
use jc_core::kinds::data_model::ModelImport;
use jc_core::kinds::{
    ContextSpaceSpec, DataModelLifecycle, DataModelSpec, EndpointSpec, MappingSpec,
    ModelProjectionSpec, Operation, OperationRef, PolicySpec, PrincipalKind,
};
use jcctl::loader::Repository;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// A broker call that has not answered in this long is a failed run, not a slow one.
const TIMEOUT: Duration = Duration::from_secs(15);

/// A view id is `[a-z0-9-]{1,63}` (Antares `views.rs`).
const MAX_ID: usize = 63;

/// The most names in one list of a view.
const MAX_NAMES: usize = 256;

/// The most rules one view holds.
const MAX_RULES: usize = 64;

/// The rows a view of another model may list (Antares `mapping::READS`, view-mapping.md
/// section 7): the reads the broker inverts and rebuilds. Any other row a Policy grants is left
/// out of a mapped view.
const MAPPED_READS: [&str; 11] = [
    "retrieve_entity",
    "query_entities",
    "retrieve_attribute_value",
    "temporal_retrieve",
    "temporal_query",
    "retrieve_entity_types",
    "retrieve_entity_type_details",
    "retrieve_entity_type_info",
    "retrieve_attributes",
    "retrieve_attribute_details",
    "retrieve_attribute_info",
];

/// What the view of a Context Space's own surface (`/cs/{space}`) is called before its segment.
pub const SPACE_VIEW_PREFIX: &str = "cs-";

/// The condition an Endpoint's or a Context Space's status carries about its view.
pub const CONDITION: &str = "ViewWritten";

/// The CIM 009 clause of a Table 4.20-1 operation, and the rows of Antares'
/// `operation-matrix.yaml` that serve it through a view. Purge, Entity Maps and the source
/// identity have no row a view serves (plan 2.1: they never enter a view).
fn operation(op: Operation) -> (&'static str, &'static [&'static str]) {
    use Operation as O;
    match op {
        O::CreateEntity => ("5.6.1", &["create_entity"]),
        O::UpdateEntity => ("5.6.2", &["update_attributes"]),
        O::AppendAttrs => ("5.6.3", &["append_attributes"]),
        O::UpdateAttrs => ("5.6.4", &["partial_attribute_update"]),
        O::DeleteAttrs => ("5.6.5", &["delete_attribute"]),
        O::DeleteEntity => ("5.6.6", &["delete_entity"]),
        O::CreateBatch => ("5.6.7", &["batch_create"]),
        O::UpsertBatch => ("5.6.8", &["batch_upsert"]),
        O::UpdateBatch => ("5.6.9", &["batch_update"]),
        O::DeleteBatch => ("5.6.10", &["batch_delete"]),
        O::UpsertTemporal => ("5.6.11", &["temporal_upsert"]),
        O::AppendAttrsTemporal => ("5.6.12", &["temporal_add_attributes"]),
        O::DeleteAttrsTemporal => ("5.6.13", &["temporal_delete_attribute"]),
        O::UpdateAttrInstanceTemporal => ("5.6.14", &["temporal_modify_instance"]),
        O::DeleteAttrInstanceTemporal => ("5.6.15", &["temporal_delete_instance"]),
        O::DeleteTemporal => ("5.6.16", &["temporal_delete"]),
        O::MergeEntity => ("5.6.17", &["merge_entity"]),
        O::ReplaceEntity => ("5.6.18", &["replace_entity"]),
        O::ReplaceAttrs => ("5.6.19", &["replace_attribute"]),
        O::MergeBatch => ("5.6.20", &["batch_merge"]),
        O::PurgeEntity => ("5.6.21", &[]),
        O::RetrieveEntity => ("5.7.1", &["retrieve_entity"]),
        O::QueryEntity => ("5.7.2", &["query_entities"]),
        O::QueryBatch => ("5.7.2", &["query_entities_post"]),
        O::RetrieveTemporal => ("5.7.3", &["temporal_retrieve"]),
        O::QueryTemporal => ("5.7.4", &["temporal_query", "temporal_query_post"]),
        O::RetrieveEntityTypes => ("5.7.5", &["retrieve_entity_types"]),
        O::RetrieveEntityTypeDetails => ("5.7.6", &["retrieve_entity_type_details"]),
        O::RetrieveEntityTypeInfo => ("5.7.7", &["retrieve_entity_type_info"]),
        O::RetrieveAttrTypes => ("5.7.8", &["retrieve_attributes"]),
        O::RetrieveAttrTypeDetails => ("5.7.9", &["retrieve_attribute_details"]),
        O::RetrieveAttrTypeInfo => ("5.7.10", &["retrieve_attribute_info"]),
        O::CreateSubscription => ("5.8.1", &["create_subscription"]),
        O::UpdateSubscription => ("5.8.2", &["update_subscription"]),
        O::RetrieveSubscription => ("5.8.3", &["retrieve_subscription"]),
        O::QuerySubscription => ("5.8.4", &["query_subscriptions"]),
        O::DeleteSubscription => ("5.8.5", &["delete_subscription"]),
        O::RetrieveEntityMap => ("5.14.1", &[]),
        O::UpdateEntityMap => ("5.14.2", &[]),
        O::DeleteEntityMap => ("5.14.3", &[]),
        O::CreateEntityMapQueryEntity => ("5.14.4", &[]),
        O::CreateEntityMapQueryTemporal => ("5.14.5", &[]),
        O::RetrieveContextSourceIdentity => ("5.15.1", &[]),
    }
}

/// The Table 4.20-1 operations a reference stands for, a Table 4.20-2 group expanded.
fn expand(reference: &OperationRef) -> &[Operation] {
    match reference {
        OperationRef::Single(op) => std::slice::from_ref(op),
        OperationRef::Group(group) => group.operations(),
    }
}

/// One Endpoint as the views are made from it.
#[derive(Debug, Clone)]
pub struct EndpointSource {
    pub project: String,
    pub name: String,
    /// Its space's broker tenant, the rendered URN segment (PF-84).
    pub tenant: String,
    pub spec: EndpointSpec,
}

/// What the views and documents are made of, read from one loaded repository.
#[derive(Debug, Default)]
pub struct Sources {
    /// Every Context Space: `(project, name, tenant)`.
    pub spaces: Vec<(String, String, String)>,
    pub endpoints: Vec<EndpointSource>,
    /// Every Policy by `(project, space)` with its manifest name, each Pipeline's derived ones
    /// included (PL-20): they reach the broker through the same Endpoints.
    pub policies: BTreeMap<(String, String), Vec<(String, PolicySpec)>>,
    /// Every `ModelProjection` by `(project, name)`.
    pub projections: BTreeMap<(String, String), ModelProjectionSpec>,
    /// The classes of each space's own data models by `(project, space)`; a mirrored model is
    /// another organisation's and selects nothing here (DM-49).
    pub classes: BTreeMap<(String, String), BTreeSet<String>>,
    /// Every App by `(project, name)`: its generated Endpoint `app-{name}` evaluates the App's
    /// own grants and the space's prohibitions alone (AP-139).
    pub apps: BTreeSet<(String, String)>,
    /// Every Mapping by `(project, name)`.
    pub mappings: BTreeMap<(String, String), MappingSource>,
    /// Each Context Space's data model by `(project, space)`: the source its `dataModelRef`
    /// names and every platform model that imports, or why they do not read. A space without
    /// `dataModelRef` has none, and its tenant no schema.
    pub models: BTreeMap<(String, String), Result<ModelSource, String>>,
}

/// One Mapping as a view of another model needs it (G18).
#[derive(Debug, Clone)]
pub struct MappingSource {
    /// The Context Space it belongs to.
    pub space: String,
    /// Its `spec.artifacts.gatewayIr` document, or why there is none to embed.
    pub ir: Result<Value, String>,
}

/// One space's data model as Model Tools compiles it (`POST /generate`, DM-76).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSource {
    /// The DataModel's name, for the messages.
    pub model: String,
    /// Its LinkML source.
    pub source: String,
    /// The source of every platform model it imports, directly or through another import, by
    /// import name (`org.{name}.v{major}`, `project.{name}.v{major}`).
    pub imports: BTreeMap<String, String>,
}

impl Sources {
    /// Reads the kinds the views are made of. A manifest whose spec does not parse is left
    /// out: the load already reported it.
    pub fn read(repo: &Repository) -> Self {
        let mut sources = Self::default();
        for (id, resource) in repo.iter() {
            let project = id.namespace.clone().unwrap_or_default();
            let spec = &resource.manifest.spec;
            match id.kind.as_str() {
                "ContextSpace" => {
                    let model = serde_json::from_value::<ContextSpaceSpec>(spec.clone())
                        .ok()
                        .and_then(|spec| spec.data_model_ref);
                    if let Some(model) = model {
                        sources.models.insert(
                            (project.clone(), id.name.clone()),
                            model_source(repo, &project, model.name()),
                        );
                    }
                    let tenant = repo.space_segment(&project, &id.name);
                    sources.spaces.push((project, id.name.clone(), tenant));
                }
                "Endpoint" => {
                    if let Ok(spec) = serde_json::from_value::<EndpointSpec>(spec.clone()) {
                        let tenant = repo.space_segment(&project, spec.context_space_ref.name());
                        sources.endpoints.push(EndpointSource {
                            project,
                            name: id.name.clone(),
                            tenant,
                            spec,
                        });
                    }
                }
                "Policy" => {
                    if let Ok(spec) = serde_json::from_value::<PolicySpec>(spec.clone()) {
                        let space = spec.context_space_ref.name().to_owned();
                        sources
                            .policies
                            .entry((project, space))
                            .or_default()
                            .push((id.name.clone(), spec));
                    }
                }
                "ModelProjection" => {
                    if let Ok(spec) = serde_json::from_value::<ModelProjectionSpec>(spec.clone()) {
                        sources.projections.insert((project, id.name.clone()), spec);
                    }
                }
                "DataModel" => {
                    let Ok(spec) = serde_json::from_value::<DataModelSpec>(spec.clone()) else {
                        continue;
                    };
                    if spec.lifecycle == DataModelLifecycle::Mirrored {
                        continue;
                    }
                    if let Some(space) = spec.context_space_ref {
                        sources
                            .classes
                            .entry((project, space))
                            .or_default()
                            .extend(spec.classes);
                    }
                }
                "App" => {
                    sources.apps.insert((project, id.name.clone()));
                }
                "Mapping" => {
                    let Ok(spec) = serde_json::from_value::<MappingSpec>(spec.clone()) else {
                        continue;
                    };
                    let ir = match &spec.artifacts.gateway_ir {
                        None => Err(format!(
                            "the Mapping {} has no spec.artifacts.gatewayIr",
                            id.name
                        )),
                        Some(relative) => crate::pipeline_validation::beside(
                            repo.root(),
                            &resource.path,
                            relative,
                        )
                        .ok_or_else(|| {
                            format!(
                                "the gatewayIr {relative:?} of the Mapping {} is no JSON file \
                                 in the repository",
                                id.name
                            )
                        }),
                    };
                    sources.mappings.insert(
                        (project, id.name.clone()),
                        MappingSource {
                            space: spec.context_space_ref,
                            ir,
                        },
                    );
                }
                _ => {}
            }
        }
        for (project, derived) in jcctl::pipeline_identity::derived(repo) {
            for (name, spec) in derived.policies {
                let space = spec.context_space_ref.name().to_owned();
                sources
                    .policies
                    .entry((project.clone(), space))
                    .or_default()
                    .push((name, spec));
            }
        }
        sources
    }

    fn policies_of(&self, project: &str, space: &str) -> &[(String, PolicySpec)] {
        self.policies
            .get(&(project.to_owned(), space.to_owned()))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn classes_of(&self, project: &str, space: &str) -> BTreeSet<String> {
        self.classes
            .get(&(project.to_owned(), space.to_owned()))
            .cloned()
            .unwrap_or_default()
    }

    /// The Policies an Endpoint evaluates, as the gateway binds them (`store.rs`
    /// `endpoints_with_models`): with `policyRef` that one Policy of its space, else every
    /// Policy of its space; an App's Endpoint keeps the App's own grants and the prohibitions.
    fn bound<'s>(&'s self, e: &EndpointSource) -> Vec<(&'s str, &'s PolicySpec)> {
        let space = e.spec.context_space_ref.name();
        let app = self.is_app(e);
        self.policies_of(&e.project, space)
            .iter()
            .filter(|(name, _)| match &e.spec.policy_ref {
                Some(reference) => {
                    reference.space() == Some(e.tenant.as_str()) && name == reference.local_id()
                }
                None => true,
            })
            .filter(|(_, policy)| {
                !app || policy.effect.is_prohibition() || own_grant(policy, &e.project, &e.name)
            })
            .map(|(name, policy)| (name.as_str(), policy))
            .collect()
    }

    /// Whether `e` is the Endpoint `app-{name}` an App of its project generated (AP-139).
    fn is_app(&self, e: &EndpointSource) -> bool {
        e.name
            .strip_prefix("app-")
            .is_some_and(|app| self.apps.contains(&(e.project.clone(), app.to_owned())))
    }
}

/// The source of the DataModel `name` of `project` and of every platform model it imports, as
/// the checkout holds them (DM-76), resolved the way `jcctl model generate` does: an import at
/// the major it pins and published, an organization model importing organization models only.
fn model_source(repo: &Repository, project: &str, name: &str) -> Result<ModelSource, String> {
    let source = model_text(repo, project, name, None)?;
    let mut imports = BTreeMap::new();
    let mut todo = vec![(project.to_owned(), source.clone())];
    while let Some((importer, text)) = todo.pop() {
        // A source that does not parse is Model Tools' message to give.
        let Ok(document) = serde_yaml_ng::from_str::<Value>(&text) else {
            continue;
        };
        for import in ModelImport::all_in(&document).map_err(|err| err.to_string())? {
            let key = import.to_string();
            if imports.contains_key(&key) {
                continue;
            }
            if imports.len() >= crate::api::datamodels::MAX_IMPORTS {
                return Err(format!(
                    "a model imports at most {} platform models, its imports' imports included",
                    crate::api::datamodels::MAX_IMPORTS
                ));
            }
            let home = match (import.organization, importer.as_str()) {
                (true, _) => ORG_NAMESPACE,
                (false, ORG_NAMESPACE) => {
                    return Err(format!(
                        "import '{key}': an organization model imports organization models only (DM-76)"
                    ))
                }
                (false, own) => own,
            };
            let text = model_text(repo, home, &import.name, Some(import.major))
                .map_err(|why| format!("import '{key}': {why}"))?;
            todo.push((home.to_owned(), text.clone()));
            imports.insert(key, text);
        }
    }
    Ok(ModelSource {
        model: name.to_owned(),
        source,
        imports,
    })
}

/// One DataModel's LinkML source from the checkout; with `major`, only a published version of
/// that major (DM-22, DM-26). The path stays inside the checkout, a symlink included.
fn model_text(
    repo: &Repository,
    namespace: &str,
    name: &str,
    major: Option<u32>,
) -> Result<String, String> {
    let (_, resource) = repo
        .iter()
        .find(|(id, _)| {
            id.kind == "DataModel" && id.name == name && id.namespace.as_deref() == Some(namespace)
        })
        .ok_or_else(|| format!("{namespace} has no DataModel {name}"))?;
    let spec: DataModelSpec = serde_json::from_value(resource.manifest.spec.clone())
        .map_err(|err| format!("the DataModel {name} does not read: {err}"))?;
    if let Some(major) = major {
        if spec.version.major() != major {
            return Err(format!(
                "'{name}' is at version {}, and the import pins major {major}",
                spec.version
            ));
        }
        if !matches!(
            spec.lifecycle,
            DataModelLifecycle::Published
                | DataModelLifecycle::Deprecated
                | DataModelLifecycle::Mirrored
        ) {
            return Err(format!(
                "'{name}' is {}; only a published model is imported (DM-26)",
                spec.lifecycle
            ));
        }
    }
    let linkml = crate::api::datamodels::confine_linkml_path(&spec.linkml)
        .map_err(|err| format!("the DataModel {name}: {err}"))?;
    let relative = resource.path.parent().unwrap_or(Path::new("")).join(linkml);
    let unread = |err: std::io::Error| format!("{} does not read: {err}", relative.display());
    let root = repo.root().canonicalize().map_err(unread)?;
    let file = root.join(&relative).canonicalize().map_err(unread)?;
    if !file.starts_with(&root) {
        return Err(format!("{} leaves the repository", relative.display()));
    }
    std::fs::read_to_string(&file).map_err(unread)
}

/// Whether `policy` is assigned to a role the Endpoint hands out (AP-96, AP-139).
fn own_grant(policy: &PolicySpec, project: &str, endpoint: &str) -> bool {
    let own = jc_core::kinds::endpoint_role(project, endpoint, None);
    policy.assignee.kind == PrincipalKind::Role
        && policy
            .assignee
            .id
            .strip_prefix(own.as_str())
            .is_some_and(|rest| {
                rest.is_empty()
                    || rest
                        .strip_prefix('/')
                        .is_some_and(|role| !role.is_empty() && !role.contains('/'))
            })
}

/// Whose a view or a document is: the object whose status reports it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Owner {
    /// `Endpoint` or `ContextSpace`.
    pub kind: &'static str,
    pub project: String,
    pub name: String,
}

impl Owner {
    fn endpoint(e: &EndpointSource) -> Self {
        Self {
            kind: "Endpoint",
            project: e.project.clone(),
            name: e.name.clone(),
        }
    }

    fn space(project: &str, name: &str) -> Self {
        Self {
            kind: "ContextSpace",
            project: project.to_owned(),
            name: name.to_owned(),
        }
    }
}

/// What one run wants the broker to hold.
#[derive(Debug, Default)]
pub struct Desired {
    /// The view documents by id.
    pub views: BTreeMap<String, (Owner, Value)>,
    /// The rule documents by tenant.
    pub documents: BTreeMap<String, (Owner, Value)>,
    /// Each tenant's data model, which becomes its schema.
    pub schemas: BTreeMap<String, (Owner, ModelSource)>,
    /// The objects the writer refused, and why.
    pub refused: Vec<(Owner, String)>,
}

/// Every view and rule document the repository declares (plan 2.1, 3.3, 5.1).
pub fn desired(sources: &Sources) -> Desired {
    let mut out = Desired::default();
    for e in &sources.endpoints {
        let owner = Owner::endpoint(e);
        let made = endpoint_view(sources, e).and_then(|view| {
            let id = e.spec.slug.to_string();
            match out.views.get(&id) {
                Some((other, _)) => Err(format!(
                    "the Endpoint {} of project {} has the same slug",
                    other.name, other.project
                )),
                None => Ok((id, view)),
            }
        });
        match made {
            Ok((id, view)) => {
                out.views.insert(id, (owner, view));
            }
            Err(reason) => out.refused.push((owner, reason)),
        }
    }
    for (project, name, tenant) in &sources.spaces {
        let owner = Owner::space(project, name);
        match space_view(sources, project, name, tenant) {
            Ok(view) => {
                out.views.insert(
                    format!("{SPACE_VIEW_PREFIX}{tenant}"),
                    (owner.clone(), view),
                );
            }
            Err(reason) => out.refused.push((owner.clone(), reason)),
        }
        if let Some((other, _)) = out.documents.get(tenant) {
            let reason = format!(
                "the Context Space {} of project {} renders the same tenant",
                other.name, other.project
            );
            out.refused.push((owner, reason));
            continue;
        }
        match sources.models.get(&(project.clone(), name.clone())) {
            Some(Ok(model)) => {
                out.schemas
                    .insert(tenant.clone(), (owner.clone(), model.clone()));
            }
            Some(Err(why)) => out.refused.push((
                owner.clone(),
                format!("its data model is not written to the broker: {why}"),
            )),
            None => {}
        }
        out.documents.insert(
            tenant.clone(),
            (owner, with_gateway(rule_document(sources, project, name))),
        );
    }
    out
}

/// The projection an Endpoint narrows by: the one it names, in its own Context Space.
fn projection_of<'a>(sources: &'a Sources, e: &EndpointSource) -> Option<&'a ModelProjectionSpec> {
    let space = e.spec.context_space_ref.name();
    e.spec.projection_ref.as_ref().and_then(|reference| {
        let project = reference.namespace.as_deref().unwrap_or(&e.project);
        sources
            .projections
            .get(&(project.to_owned(), reference.name.clone()))
            .filter(|projection| projection.context_space_ref == space)
    })
}

/// The view of one Endpoint (plan 2.1), or why it has none.
fn endpoint_view(sources: &Sources, e: &EndpointSource) -> Result<Value, String> {
    let mapping = view_mapping(sources, e)?;
    let id = e.spec.slug.to_string();
    if id.len() > MAX_ID {
        return Err(format!(
            "the slug is {} characters and a view id at most {MAX_ID}",
            id.len()
        ));
    }
    let permits: Vec<&PolicySpec> = sources
        .bound(e)
        .into_iter()
        .map(|(_, policy)| policy)
        .filter(|policy| !policy.effect.is_prohibition())
        .collect();
    if permits.is_empty() {
        return Err("no Policy grants anything through this Endpoint".into());
    }
    let hidden: BTreeSet<String> = e
        .spec
        .projection
        .iter()
        .flat_map(|projection| projection.hidden_attributes.iter().cloned())
        .collect();
    let space = e.spec.context_space_ref.name();
    let projection = projection_of(sources, e);

    let mut view = Map::new();
    view.insert("id".into(), json!(id));
    view.insert("tenant".into(), json!(e.tenant));
    let shown = match projection {
        Some(projection) => {
            // its `temporalQ` is the window of the view's permits, in the rule document
            let filter = projection.filter.clone().unwrap_or_default();
            if let Some(window) = &filter.temporal_q {
                for policy in &permits {
                    intersect(window, policy.temporal_q.as_deref()).map_err(|why| {
                        format!("the projection's temporalQ and a Policy's: {why}")
                    })?;
                }
            }
            if let Some(q) = filter.q {
                view.insert("q".into(), json!(q));
            }
            if let Some(scope_q) = filter.scope_q {
                view.insert("scopeQ".into(), json!(scope_q));
            }
            if let Some(geo_q) = filter.geo_q {
                view.insert("geoQ".into(), geo(&geo_q)?);
            }
            projection
                .classes
                .iter()
                .map(|class| {
                    let slots = (!class.slots.is_empty())
                        .then(|| class.slots.iter().cloned().collect::<BTreeSet<_>>());
                    (class.name.clone(), slots)
                })
                .collect()
        }
        None => granted(&permits, &sources.classes_of(&e.project, space))?,
    };
    let model = sources
        .models
        .get(&(e.project.clone(), space.to_owned()))
        .and_then(|model| model.as_ref().ok())
        .map(parsed);
    let mut rules = rules(listed(shown, model.as_deref())?, &hidden)?;
    let mut operations = rows(&permits)?;
    if let Some((ir, target, source)) = &mapping {
        // the broker judges a mapped view in the model it stores, as the gateway's
        // `Constraints::in_source_model` does; Attribute names are the source's already
        for (_, types) in &mut rules {
            for t in types.iter_mut().filter(|t| *t == target) {
                t.clone_from(source);
            }
            types.sort();
            types.dedup();
        }
        if let Some(other) = rules
            .iter()
            .flat_map(|(_, types)| types)
            .find(|t| *t != source)
        {
            return Err(format!(
                "a view of another model selects its source class {source} alone, and the \
                 Policies also name {other}"
            ));
        }
        operations.retain(|row| MAPPED_READS.contains(row));
        if operations.is_empty() {
            return Err("its Policies grant no read a view of another model serves".into());
        }
        view.insert("mapping".into(), ir.clone());
    }
    let selector: BTreeSet<&String> = rules.iter().flat_map(|(_, types)| types).collect();
    if selector.len() > MAX_NAMES {
        return Err(format!(
            "it selects {} types and a view at most {MAX_NAMES}",
            selector.len()
        ));
    }
    view.insert("selector".into(), json!(selector));
    view.insert(
        "rules".into(),
        Value::Array(
            rules
                .iter()
                .map(|(attributes, types)| json!({"types": types, "attributes": attributes}))
                .collect(),
        ),
    );
    view.insert("operations".into(), json!(operations));
    Ok(Value::Object(view))
}

/// The IR, target class and source class of an Endpoint's `viewMappingRef` (G18), or why it
/// cannot be served as a view.
fn view_mapping(
    sources: &Sources,
    e: &EndpointSource,
) -> Result<Option<(Value, String, String)>, String> {
    let Some(reference) = &e.spec.view_mapping_ref else {
        return Ok(None);
    };
    let project = reference.namespace.as_deref().unwrap_or(&e.project);
    let mapping = sources
        .mappings
        .get(&(project.to_owned(), reference.name.clone()))
        .filter(|m| m.space == e.spec.context_space_ref.name())
        .ok_or_else(|| {
            format!(
                "viewMappingRef names {}, which is no Mapping of this Context Space",
                reference.name
            )
        })?;
    let ir = mapping.ir.clone()?;
    let class = |member: &str| {
        ir.get(member)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("the IR of the Mapping {} names no {member}", reference.name))
    };
    let (target, source) = (class("targetClass")?, class("sourceClass")?);
    Ok(Some((ir, target, source)))
}

/// What the Policies name, type by type: `None` is the whole Entity. A permission without
/// `information` grants every type, which the view writes as the space model's classes.
fn granted(
    permits: &[&PolicySpec],
    classes: &BTreeSet<String>,
) -> Result<BTreeMap<String, Option<BTreeSet<String>>>, String> {
    let mut shown: BTreeMap<String, Option<BTreeSet<String>>> = BTreeMap::new();
    let mut add = |entity_type: &str, attributes: Option<BTreeSet<String>>| {
        let entry = shown
            .entry(entity_type.to_owned())
            .or_insert(Some(BTreeSet::new()));
        match (entry.as_mut(), attributes) {
            (Some(held), Some(more)) => held.extend(more),
            _ => *entry = None,
        }
    };
    for policy in permits {
        if policy.information.is_empty() {
            if classes.is_empty() {
                return Err(
                    "a Policy grants every type and the space's data model names no \
                            class to select"
                        .into(),
                );
            }
            for class in classes {
                add(class, None);
            }
        }
        for info in &policy.information {
            let attributes: BTreeSet<String> = info
                .property_names
                .iter()
                .chain(&info.relationship_names)
                .cloned()
                .collect();
            for selector in &info.entities {
                add(
                    &selector.entity_type,
                    (!attributes.is_empty()).then(|| attributes.clone()),
                );
            }
        }
    }
    Ok(shown)
}

/// The space model's documents, its own source and every import, as YAML; one that does not
/// parse is left out, as Model Tools would refuse it.
fn parsed(model: &ModelSource) -> Vec<serde_yaml_ng::Value> {
    std::iter::once(&model.source)
        .chain(model.imports.values())
        .filter_map(|text| serde_yaml_ng::from_str(text).ok())
        .collect()
}

/// The Attributes of `class` in the model: its `slots` and inline `attributes` and those of
/// every class it reaches through `is_a` and `mixins`, without the identifier slots (the
/// Entity's `id` and `type` are no Attribute). `None` when the model has no such class.
fn class_slots(model: &[serde_yaml_ng::Value], class: &str) -> Option<BTreeSet<String>> {
    let find = |section: &str, name: &str| {
        model
            .iter()
            .find_map(|doc| doc.get(section).and_then(|entries| entries.get(name)))
    };
    let names = |value: Option<&serde_yaml_ng::Value>| -> Vec<String> {
        match value {
            Some(serde_yaml_ng::Value::Sequence(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
            Some(serde_yaml_ng::Value::Mapping(entries)) => entries
                .keys()
                .filter_map(|key| key.as_str().map(str::to_owned))
                .collect(),
            Some(serde_yaml_ng::Value::String(one)) => vec![one.clone()],
            _ => Vec::new(),
        }
    };
    find("classes", class)?;
    let mut slots = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut todo = vec![class.to_owned()];
    while let Some(name) = todo.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some(definition) = find("classes", &name) else {
            continue;
        };
        slots.extend(names(definition.get("slots")));
        slots.extend(names(definition.get("attributes")));
        todo.extend(names(definition.get("is_a")));
        todo.extend(names(definition.get("mixins")));
    }
    slots.retain(|slot| {
        let identifier = find("slots", slot)
            .and_then(|definition| definition.get("identifier"))
            .and_then(serde_yaml_ng::Value::as_bool)
            .unwrap_or(false);
        !identifier && slot != "id" && slot != "type"
    });
    Some(slots)
}

/// What each type shows as a list of Attributes: a type shown whole lists its class's slots
/// from the space's data model, since Antares reads an empty list as no Attribute (ADR-0023
/// rule 11). A type shown whole with no class in the model is refused, never written empty.
fn listed(
    shown: BTreeMap<String, Option<BTreeSet<String>>>,
    model: Option<&[serde_yaml_ng::Value]>,
) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    shown
        .into_iter()
        .map(|(entity_type, attributes)| match attributes {
            Some(attributes) => Ok((entity_type, attributes)),
            None => model
                .and_then(|model| class_slots(model, &entity_type))
                .map(|slots| (entity_type.clone(), slots))
                .ok_or_else(|| {
                    format!(
                        "{entity_type} is shown whole and the space's data model has no class \
                         {entity_type}: list the Attributes it shows"
                    )
                }),
        })
        .collect()
}

/// One rule of a view: the Attributes it shows and its types.
type Rule = (Vec<String>, Vec<String>);

/// The rules of a view: the types that show the same Attributes share one. A type whose every
/// Attribute is hidden shows nothing and is left out.
fn rules(
    shown: BTreeMap<String, BTreeSet<String>>,
    hidden: &BTreeSet<String>,
) -> Result<Vec<Rule>, String> {
    let mut by_attributes: BTreeMap<Vec<String>, Vec<String>> = BTreeMap::new();
    for (entity_type, attributes) in shown {
        let attributes: Vec<String> = attributes.difference(hidden).cloned().collect();
        if attributes.is_empty() {
            continue;
        }
        if attributes.len() > MAX_NAMES {
            return Err(format!(
                "{entity_type} shows {} Attributes and a view rule at most {MAX_NAMES}",
                attributes.len()
            ));
        }
        by_attributes
            .entry(attributes)
            .or_default()
            .push(entity_type);
    }
    if by_attributes.is_empty() {
        return Err("it shows no Attribute of any type".into());
    }
    if by_attributes.len() > MAX_RULES {
        return Err(format!(
            "its types show {} different Attribute lists and a view holds at most {MAX_RULES} \
             rules",
            by_attributes.len()
        ));
    }
    Ok(by_attributes.into_iter().collect())
}

/// The matrix rows the permissions grant, in name order.
fn rows(permits: &[&PolicySpec]) -> Result<Vec<&'static str>, String> {
    let rows: BTreeSet<&'static str> = permits
        .iter()
        .flat_map(|policy| &policy.operations)
        .flat_map(expand)
        .flat_map(|op| operation(*op).1.iter().copied())
        .collect();
    if rows.is_empty() {
        return Err("its Policies grant no operation a view serves".into());
    }
    Ok(rows.into_iter().collect())
}

/// A `geoQ` written as `georel=…;geometry=…;coordinates=…[;geoproperty=…]` as the view's
/// object; `near;maxDistance==…` keeps its distance in `georel`.
fn geo(raw: &str) -> Result<Value, String> {
    let mut parts: BTreeMap<&str, String> = BTreeMap::new();
    for part in raw.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('=') {
            Some((key @ ("georel" | "geometry" | "coordinates" | "geoproperty"), value)) => {
                parts.insert(key, value.to_owned());
            }
            _ if part.starts_with("maxDistance") || part.starts_with("minDistance") => {
                let georel = parts
                    .get_mut("georel")
                    .ok_or_else(|| format!("geoQ {raw:?}: {part:?} comes before georel"))?;
                georel.push(';');
                georel.push_str(part);
            }
            _ => return Err(format!("geoQ {raw:?}: {part:?} is not a geoquery member")),
        }
    }
    let mut out = Map::new();
    for key in ["georel", "geometry", "coordinates"] {
        let value = parts
            .remove(key)
            .ok_or_else(|| format!("geoQ {raw:?} has no {key}"))?;
        out.insert(key.into(), json!(value));
    }
    if let Some(property) = parts.remove("geoproperty") {
        out.insert("geoproperty".into(), json!(property));
    }
    Ok(Value::Object(out))
}

/// The view of the space surface `/cs/{space}` (plan 5.1): every type and Attribute (the `*`
/// form, ADR-0023 rule 12) with every operation its Policies grant; the engine narrows it per
/// subject. No Endpoint view takes this form.
fn space_view(sources: &Sources, project: &str, name: &str, tenant: &str) -> Result<Value, String> {
    let id = format!("{SPACE_VIEW_PREFIX}{tenant}");
    if id.len() > MAX_ID {
        return Err(format!(
            "the view {id} is {} characters and a view id at most {MAX_ID}",
            id.len()
        ));
    }
    let permits: Vec<&PolicySpec> = sources
        .policies_of(project, name)
        .iter()
        .map(|(_, policy)| policy)
        .filter(|policy| !policy.effect.is_prohibition())
        .collect();
    Ok(json!({
        "id": id,
        "tenant": tenant,
        "selector": ["*"],
        "rules": [{"types": ["*"], "attributes": ["*"]}],
        "operations": rows(&permits)?,
    }))
}

/// The rule document of one space's tenant (plan 3.3, the `joinedcontext` engine's README
/// section 2): every Policy, each operation as its clause, and per Endpoint view that binds
/// fewer than all of them (`policyRef`, an App's Endpoint) the ids it is decided by (T-3702).
fn rule_document(sources: &Sources, project: &str, space: &str) -> Value {
    let mut policies: Vec<Value> = sources
        .policies_of(project, space)
        .iter()
        .map(|(name, policy)| policy_document(format!("{project}/{name}"), policy, None))
        .collect();
    let mut views = Map::new();
    for e in sources
        .endpoints
        .iter()
        .filter(|e| e.project == project && e.spec.context_space_ref.name() == space)
    {
        let window = projection_of(sources, e)
            .and_then(|projection| projection.filter.as_ref())
            .and_then(|filter| filter.temporal_q.as_deref());
        // a view not listed is decided by every Policy, as it was written
        if e.spec.policy_ref.is_none() && !sources.is_app(e) && window.is_none() {
            continue;
        }
        let slug = e.spec.slug.to_string();
        let mut ids = Vec::new();
        for (name, policy) in sources.bound(e) {
            // The projection's window narrows every permit bound to the view (T-3632, G6): a
            // permit's own window is intersected with it; a prohibition keeps every time.
            let Some(window) = window.filter(|_| !policy.effect.is_prohibition()) else {
                ids.push(format!("{project}/{name}"));
                continue;
            };
            // `endpoint_view` refuses a view whose windows cannot be intersected, so this one
            // is never written; its permit is listed nowhere and grants nothing through it.
            let Ok(narrowed) = intersect(window, policy.temporal_q.as_deref()) else {
                continue;
            };
            let id = format!("{project}/{name}@{slug}");
            policies.push(policy_document(id.clone(), policy, Some(&narrowed)));
            ids.push(id);
        }
        views.insert(slug, json!(ids));
    }
    if views.is_empty() {
        return json!({ "policies": policies });
    }
    json!({ "policies": policies, "views": views })
}

/// One end of a `temporalQ` window as the engine reads it (Antares
/// `addons/joinedcontext-policy/src/document.rs` `bound`): an instant, or a duration before now.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Bound {
    At(chrono::DateTime<chrono::Utc>),
    Ago(chrono::Duration),
}

/// The window `[from, to)` of a `temporalQ`, each end with the text it was written as.
type Window<'a> = (Option<(Bound, &'a str)>, Option<(Bound, &'a str)>);

fn window(raw: &str) -> Result<Window<'_>, String> {
    let (mut rel, mut at, mut end) = (None, None, None);
    for part in raw.split([';', '&']) {
        match part.split_once('=').map(|(k, v)| (k.trim(), v.trim())) {
            Some(("timerel", v)) => rel = Some(v),
            Some(("timeAt", v)) => at = Some((bound(v)?, v)),
            Some(("endTimeAt", v)) => end = Some((bound(v)?, v)),
            _ => return Err(format!("{part:?} is not timerel, timeAt or endTimeAt")),
        }
    }
    match rel {
        Some("after") => Ok((Some(at.ok_or("no timeAt")?), None)),
        Some("before") => Ok((None, Some(at.ok_or("no timeAt")?))),
        Some("between") => Ok((
            Some(at.ok_or("no timeAt")?),
            Some(end.ok_or("no endTimeAt")?),
        )),
        other => Err(format!("timerel {other:?} is not before, after or between")),
    }
}

fn bound(raw: &str) -> Result<Bound, String> {
    if let Ok(at) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(Bound::At(at.with_timezone(&chrono::Utc)));
    }
    ago(raw)
        .map(Bound::Ago)
        .ok_or_else(|| format!("{raw:?} is neither an instant nor a duration before now"))
}

/// `P-1D`, `-P1D`, `PT-2H30M`: how long before now, in weeks, days, hours, minutes and seconds
/// (months and years have no fixed length, the engine refuses them too).
fn ago(raw: &str) -> Option<chrono::Duration> {
    let (mut negative, rest) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw),
    };
    let rest = rest.strip_prefix('P')?;
    let (date, time) = rest.split_once('T').unwrap_or((rest, ""));
    let mut total = chrono::Duration::zero();
    let mut digits = String::new();
    let mut units = 0;
    for (part, allowed) in [(date, "WD"), (time, "HMS")] {
        for c in part.chars() {
            match c {
                '-' if digits.is_empty() => negative = !negative,
                '0'..='9' => digits.push(c),
                u if allowed.contains(u) => {
                    let n: i64 = digits.parse().ok()?;
                    digits.clear();
                    units += 1;
                    total = total.checked_add(&match u {
                        'W' => chrono::Duration::try_weeks(n)?,
                        'D' => chrono::Duration::try_days(n)?,
                        'H' => chrono::Duration::try_hours(n)?,
                        'M' => chrono::Duration::try_minutes(n)?,
                        _ => chrono::Duration::try_seconds(n)?,
                    })?;
                }
                _ => return None,
            }
        }
    }
    (negative && units > 0 && digits.is_empty() && total > chrono::Duration::zero())
        .then_some(total)
}

/// The later (`later`) or earlier of two ends, or why they cannot be told apart: an instant and
/// a duration before now order differently as time passes.
fn pick<'a>(
    a: Option<(Bound, &'a str)>,
    b: Option<(Bound, &'a str)>,
    later: bool,
) -> Result<Option<(Bound, &'a str)>, String> {
    let (Some(x), Some(y)) = (a, b) else {
        return Ok(a.or(b));
    };
    let x_first = match (x.0, y.0) {
        (Bound::At(p), Bound::At(q)) => p <= q,
        // further back is earlier
        (Bound::Ago(p), Bound::Ago(q)) => p >= q,
        _ => {
            return Err(format!(
                "{} and {} cannot be compared, one is an instant and one a time before now",
                x.1, y.1
            ))
        }
    };
    Ok(Some(if x_first == later { y } else { x }))
}

/// The `temporalQ` that holds both `projection` and `own` (a Policy's), as the engine reads one:
/// the later start and the earlier end.
fn intersect(projection: &str, own: Option<&str>) -> Result<String, String> {
    let (from_a, to_a) = window(projection)?;
    let (from_b, to_b) = match own {
        Some(own) => window(own)?,
        None => (None, None),
    };
    let from = pick(from_a, from_b, true)?;
    let to = pick(to_a, to_b, false)?;
    Ok(match (from, to) {
        (Some((_, f)), Some((_, t))) => format!("timerel=between;timeAt={f};endTimeAt={t}"),
        (Some((_, f)), None) => format!("timerel=after;timeAt={f}"),
        (None, Some((_, t))) => format!("timerel=before;timeAt={t}"),
        (None, None) => return Err("no timeAt".into()),
    })
}

/// One Policy as the engine reads it (README section 2), under `id`, its `temporalQ` the
/// `window` when one is given (already intersected with the Policy's own).
fn policy_document(id: String, policy: &PolicySpec, window: Option<&str>) -> Value {
    let mut clauses: Vec<&str> = Vec::new();
    for op in policy.operations.iter().flat_map(expand) {
        let clause = operation(*op).0;
        if !clauses.contains(&clause) {
            clauses.push(clause);
        }
    }
    let mut doc = Map::new();
    doc.insert("id".into(), json!(id));
    doc.insert(
        "effect".into(),
        json!(if policy.effect.is_prohibition() {
            "prohibit"
        } else {
            "permit"
        }),
    );
    doc.insert(
        "assignee".into(),
        json!({"kind": policy.assignee.kind.as_str(), "id": policy.assignee.id}),
    );
    doc.insert("operations".into(), json!(clauses));
    if let Some(validity) = &policy.validity {
        doc.insert("validity".into(), json!(validity));
    }
    if !policy.information.is_empty() {
        doc.insert("information".into(), json!(policy.information));
    }
    for (key, value) in [
        ("q", policy.q.as_deref()),
        ("scopeQ", policy.scope_q.as_deref()),
        ("geoQ", policy.geo_q.as_deref()),
        ("temporalQ", window.or(policy.temporal_q.as_deref())),
    ] {
        if let Some(value) = value {
            doc.insert(key.into(), json!(value));
        }
    }
    Value::Object(doc)
}

/// The gateway's own account (context-gateway `GATEWAY_CLIENT`, T-3767): the hops it makes on
/// nobody's behalf (a conditional write's probe, a held delete's unlink, a notification's read,
/// a download's type list).
const GATEWAY_CLIENT: &str = "context-gateway";

/// The clauses those hops use: the unlinking's attribute patch, attribute delete and entity
/// delete, the probes' retrieve and query, a download's type list (T-3790), the stored
/// subscription's retrieve.
const GATEWAY_CLAUSES: &[&str] = &[
    "5.6.4", "5.6.5", "5.6.6", "5.7.1", "5.7.2", "5.7.5", "5.8.3",
];

/// A rule document plus the one policy that admits the gateway's own hops; `@` keeps its id
/// apart from every `{project}/{name}`.
fn with_gateway(mut document: Value) -> Value {
    if let Some(policies) = document["policies"].as_array_mut() {
        policies.push(json!({
            "id": format!("@{GATEWAY_CLIENT}"),
            "effect": "permit",
            "assignee": {"kind": "serviceAccount", "id": GATEWAY_CLIENT},
            "operations": GATEWAY_CLAUSES,
        }));
    }
    document
}

/// Whether the writer owns a view of this id: an Endpoint slug or a space surface.
fn owned(id: &str) -> bool {
    id.starts_with(SPACE_VIEW_PREFIX)
        || ((26..=MAX_ID).contains(&id.len())
            && id.bytes().all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7')))
}

/// What happened to one Endpoint's or Context Space's view and document in a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewOutcome {
    /// The broker holds what the repository declares.
    Written,
    /// The writer cannot express it; nothing was sent.
    Refused(String),
    /// The broker refused it or did not answer.
    Failed(String),
}

/// One HTTP client, the broker's address and where its admin token is mounted.
pub struct ViewSync {
    http: reqwest::Client,
    /// The broker as this Portal reaches it, without a trailing slash.
    broker: String,
    token_file: PathBuf,
    /// The tenants whose rule document this Portal wrote since it started: only those are
    /// deleted when their space goes.
    // ponytail: in memory, so a space deleted while the Portal restarts keeps its document;
    // with no view left to route to it, nothing reads it.
    written_documents: Mutex<BTreeSet<String>>,
    /// Model Tools, which compiles a space's data model into its tenant's schema.
    model_tools: Option<String>,
    /// The tenants whose schema this Portal wrote since it started, as `written_documents`.
    written_schemas: Mutex<BTreeSet<String>>,
    /// The last schema compiled per tenant and the model it came from: an unchanged model is
    /// not compiled again on every run.
    // ponytail: a Model Tools upgrade reaches an unchanged model when the Portal restarts.
    compiled: Mutex<BTreeMap<String, (ModelSource, Value)>>,
}

impl ViewSync {
    /// A writer against one broker, its admin token read from `token_file` on every run.
    pub fn new(broker: impl Into<String>, token_file: impl Into<PathBuf>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .unwrap_or_default(),
            broker: broker.into().trim_end_matches('/').to_owned(),
            token_file: token_file.into(),
            written_documents: Mutex::default(),
            model_tools: None,
            written_schemas: Mutex::default(),
            compiled: Mutex::default(),
        }
    }

    /// Compiles each space's data model with the Model Tools at `url` and writes it as the
    /// tenant's schema. Without it a space with a `dataModelRef` says its schema is not written.
    pub fn with_model_tools(mut self, url: impl Into<String>) -> Self {
        self.model_tools = Some(url.into().trim_end_matches('/').to_owned());
        self
    }

    /// Brings the broker's views and rule documents to what the repository declares, and says
    /// per Endpoint and Context Space what happened.
    pub async fn converge(&self, repo: &Repository) -> Vec<(Owner, ViewOutcome)> {
        self.apply(desired(&Sources::read(repo))).await
    }

    async fn apply(&self, desired: Desired) -> Vec<(Owner, ViewOutcome)> {
        let mut outcomes: BTreeMap<Owner, ViewOutcome> = BTreeMap::new();
        for (owner, reason) in desired.refused {
            outcomes.insert(owner, ViewOutcome::Refused(reason));
        }
        let mut note = |owner: &Owner, outcome: ViewOutcome| {
            let held = outcomes
                .entry(owner.clone())
                .or_insert(ViewOutcome::Written);
            if *held == ViewOutcome::Written {
                *held = outcome;
            }
        };
        let token = match std::fs::read_to_string(&self.token_file) {
            Ok(token) if !token.trim().is_empty() => token.trim().to_owned(),
            _ => {
                let reason = format!(
                    "the broker's admin token is not readable at {}",
                    self.token_file.display()
                );
                for (owner, _) in desired.views.values().chain(desired.documents.values()) {
                    note(owner, ViewOutcome::Failed(reason.clone()));
                }
                return outcomes.into_iter().collect();
            }
        };

        let listed = match self.get(&token, "/q/views").await {
            Ok(Some(Value::Object(listed))) => listed,
            other => {
                let reason = match other {
                    Err(reason) => reason,
                    _ => "the broker serves no views (built without the views feature)".into(),
                };
                for (owner, _) in desired.views.values().chain(desired.documents.values()) {
                    note(owner, ViewOutcome::Failed(reason.clone()));
                }
                return outcomes.into_iter().collect();
            }
        };
        for (id, (owner, view)) in &desired.views {
            let outcome = self
                .put_if_changed(&token, &format!("/q/views/{id}"), view)
                .await;
            note(owner, outcome);
        }
        for id in listed.keys() {
            if owned(id) && !desired.views.contains_key(id) {
                match self.delete(&token, &format!("/q/views/{id}")).await {
                    Ok(()) => tracing::info!(view = %id, "view removed with its Endpoint or space"),
                    Err(reason) => tracing::warn!(view = %id, %reason, "view not removed"),
                }
            }
        }

        for (tenant, (owner, model)) in &desired.schemas {
            let outcome = match self.broker_schema(tenant, model).await {
                Ok(schema) => {
                    self.put_if_changed(&token, &format!("/q/schemas/{tenant}"), &schema)
                        .await
                }
                Err(outcome) => outcome,
            };
            if outcome == ViewOutcome::Written {
                lock(&self.written_schemas).insert(tenant.clone());
            }
            note(owner, outcome);
        }
        let gone: Vec<String> = lock(&self.written_schemas)
            .iter()
            .filter(|tenant| !desired.schemas.contains_key(*tenant))
            .cloned()
            .collect();
        for tenant in gone {
            match self.delete(&token, &format!("/q/schemas/{tenant}")).await {
                Ok(()) => {
                    lock(&self.written_schemas).remove(&tenant);
                    tracing::info!(%tenant, "schema removed with its space's data model");
                }
                Err(reason) => tracing::warn!(%tenant, %reason, "schema not removed"),
            }
        }

        // No engine that reads rule documents: `/q/policy` answers 404 and the views stand
        // under whatever engine the broker runs.
        match self.get(&token, "/q/policy").await {
            Ok(Some(_)) => {}
            Ok(None) => {
                tracing::debug!("the broker runs no engine that reads rule documents");
                return outcomes.into_iter().collect();
            }
            Err(reason) => {
                for (owner, _) in desired.documents.values() {
                    note(owner, ViewOutcome::Failed(reason.clone()));
                }
                return outcomes.into_iter().collect();
            }
        }
        for (tenant, (owner, document)) in &desired.documents {
            let path = format!("/q/policy/{tenant}");
            let outcome = match self.get(&token, &path).await {
                Ok(Some(stored)) if stored.get("document") == Some(document) => {
                    ViewOutcome::Written
                }
                Ok(_) => self.put(&token, &path, document).await,
                Err(reason) => ViewOutcome::Failed(reason),
            };
            if outcome == ViewOutcome::Written {
                self.written().insert(tenant.clone());
            }
            note(owner, outcome);
        }
        let gone: Vec<String> = self
            .written()
            .iter()
            .filter(|tenant| !desired.documents.contains_key(*tenant))
            .cloned()
            .collect();
        for tenant in gone {
            match self.delete(&token, &format!("/q/policy/{tenant}")).await {
                Ok(()) => {
                    self.written().remove(&tenant);
                    tracing::info!(%tenant, "rule document removed with its space");
                }
                Err(reason) => tracing::warn!(%tenant, %reason, "rule document not removed"),
            }
        }
        outcomes.into_iter().collect()
    }

    fn written(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        lock(&self.written_documents)
    }

    /// The `brokerSchema` Model Tools compiles from a space's data model, or what the space's
    /// condition says instead: a model that does not compile is refused with its messages.
    async fn broker_schema(&self, tenant: &str, model: &ModelSource) -> Result<Value, ViewOutcome> {
        if let Some((held, schema)) = lock(&self.compiled).get(tenant) {
            if held == model {
                return Ok(schema.clone());
            }
        }
        let name = &model.model;
        let Some(base) = &self.model_tools else {
            return Err(ViewOutcome::Failed(format!(
                "no model tools service is configured (JC_PORTAL_MODEL_TOOLS_URL), so the data \
                 model {name} is not compiled into the broker's schema"
            )));
        };
        let mut body = json!({ "source": model.source });
        if !model.imports.is_empty() {
            body["imports"] = json!(model.imports);
        }
        let response = self
            .http
            .post(format!("{base}/generate"))
            .json(&body)
            .send()
            .await
            .map_err(|err| {
                ViewOutcome::Failed(format!(
                    "model tools did not answer for the data model {name}: {err}"
                ))
            })?;
        if !response.status().is_success() {
            let what = format!("model tools refused the data model {name}");
            return Err(ViewOutcome::Failed(refusal(&what, response).await));
        }
        let artifacts: crate::tools::model_tools::Artifacts =
            response.json().await.map_err(|err| {
                ViewOutcome::Failed(format!(
                    "model tools answered the data model {name} unreadably: {err}"
                ))
            })?;
        match artifacts.broker_schema {
            Some(schema) => {
                lock(&self.compiled).insert(tenant.to_owned(), (model.clone(), schema.clone()));
                Ok(schema)
            }
            None if !artifacts.errors.is_empty() => Err(ViewOutcome::Refused(format!(
                "the data model {name} does not compile: {}",
                artifacts.errors.join("; ")
            ))),
            None => Err(ViewOutcome::Failed(format!(
                "model tools rendered no brokerSchema for the data model {name}: its version \
                 predates T-3703"
            ))),
        }
    }

    async fn put_if_changed(&self, token: &str, path: &str, doc: &Value) -> ViewOutcome {
        match self.get(token, path).await {
            Ok(Some(stored)) if stored == *doc => ViewOutcome::Written,
            Ok(_) => self.put(token, path, doc).await,
            Err(reason) => ViewOutcome::Failed(reason),
        }
    }

    /// The JSON at `path`, `None` on 404.
    async fn get(&self, token: &str, path: &str) -> Result<Option<Value>, String> {
        let response = self
            .http
            .get(format!("{}{path}", self.broker))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|err| format!("the broker did not answer GET {path}: {err}"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(refusal(&format!("GET {path}"), response).await);
        }
        response
            .json()
            .await
            .map(Some)
            .map_err(|err| format!("GET {path} did not answer JSON: {err}"))
    }

    async fn put(&self, token: &str, path: &str, doc: &Value) -> ViewOutcome {
        let sent = self
            .http
            .put(format!("{}{path}", self.broker))
            .bearer_auth(token)
            .json(doc)
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_success() => ViewOutcome::Written,
            Ok(response) => ViewOutcome::Failed(
                refusal(&format!("the broker refused PUT {path}"), response).await,
            ),
            Err(err) => ViewOutcome::Failed(format!("the broker did not answer PUT {path}: {err}")),
        }
    }

    async fn delete(&self, token: &str, path: &str) -> Result<(), String> {
        let response = self
            .http
            .delete(format!("{}{path}", self.broker))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        match response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND
        {
            true => Ok(()),
            false => Err(refusal(&format!("DELETE {path}"), response).await),
        }
    }
}

/// A lock a panicked holder left poisoned still holds a whole set.
fn lock<T>(held: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    held.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `what: status: detail`, the detail of a problem document when it is one, cut short.
async fn refusal(what: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|problem| {
            problem
                .get("detail")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or(body);
    let mut said = detail.trim().replace('\n', " ");
    if said.len() > 300 {
        let mut end = 300;
        while !said.is_char_boundary(end) {
            end -= 1;
        }
        said.truncate(end);
    }
    match said.is_empty() {
        true => format!("{what}: {status}"),
        false => format!("{what}: {status}: {said}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SLUG: &str = "k4y7pq2mzt6vhx3nbwrs5cjdaf";

    fn endpoint(spec: Value) -> EndpointSource {
        endpoint_named("air-public", spec)
    }

    fn endpoint_named(name: &str, extra: Value) -> EndpointSource {
        let mut spec = json!({
            "contextSpaceRef": "air", "slug": SLUG, "audience": "public",
            "enabledRepresentations": ["ngsi-ld"]
        });
        if let (Some(spec), Some(extra)) = (spec.as_object_mut(), extra.as_object()) {
            spec.extend(extra.clone());
        }
        EndpointSource {
            project: "city".into(),
            name: name.into(),
            tenant: "city-air".into(),
            spec: serde_json::from_value(spec).expect("an Endpoint spec"),
        }
    }

    fn policy(extra: Value) -> PolicySpec {
        let mut spec = json!({
            "contextSpaceRef": "air", "assigner": "did:web:city.example",
            "assignee": {"kind": "role", "id": "public"},
            "operations": ["retrieveOps"]
        });
        if let (Some(spec), Some(extra)) = (spec.as_object_mut(), extra.as_object()) {
            spec.extend(extra.clone());
        }
        serde_json::from_value(spec).expect("a Policy spec")
    }

    fn sources(policies: Vec<(&str, PolicySpec)>) -> Sources {
        let mut sources = Sources::default();
        sources
            .spaces
            .push(("city".into(), "air".into(), "city-air".into()));
        sources.policies.insert(
            ("city".into(), "air".into()),
            policies
                .into_iter()
                .map(|(name, spec)| (name.to_owned(), spec))
                .collect(),
        );
        sources
    }

    /// `s` with `fleet_model()` as its space's data model.
    fn fleet(mut s: Sources) -> Sources {
        s.models
            .insert(("city".into(), "air".into()), Ok(fleet_model()));
        s
    }

    /// The space's model: Car and Bus inherit `speed` from Vehicle, Car adds `ownedBy` past
    /// its identifier slot, Stop takes `location` from a mixin, and an import holds Vehicle.
    fn fleet_model() -> ModelSource {
        ModelSource {
            model: "fleet".into(),
            source: "id: https://city.example/fleet\nname: fleet\nimports: [org.vehicles.v1]\n\
                     classes:\n  Car: {is_a: Vehicle, slots: [id, ownedBy]}\n  Bus: {is_a: Vehicle}\n\
                     \x20 Stop: {slots: [name], mixins: [Located]}\n  Located: {mixin: true, slots: [location]}\n\
                     slots:\n  id: {identifier: true}\n  ownedBy: {}\n  name: {}\n  location: {}\n"
                .into(),
            imports: BTreeMap::from([(
                "org.vehicles.v1".to_owned(),
                "id: https://city.example/vehicles\nname: vehicles\n\
                 classes:\n  Vehicle: {attributes: {speed: {range: float}}, is_a: Vehicle}\n"
                    .to_owned(),
            )]),
        }
    }

    fn cars() -> PolicySpec {
        policy(
            json!({"information": [{"entities": [{"type": "Car"}], "propertyNames": ["speed"]}]}),
        )
    }

    fn view_of(sources: &Sources, e: &EndpointSource) -> Result<Value, String> {
        endpoint_view(sources, e)
    }

    /// Plan 2.1 `id`, `tenant`, `selector` and `rules` without a projection: the slug, the
    /// space's segment, the Policies' types with their Attributes; `operations` the rows of the
    /// group they grant.
    #[test]
    fn an_endpoint_view_is_its_slug_tenant_and_policies() {
        let s = sources(vec![("cars", cars())]);
        let view = view_of(&s, &endpoint(json!({}))).expect("a view");
        assert_eq!(
            view,
            json!({"id": SLUG, "tenant": "city-air", "selector": ["Car"],
                   "rules": [{"types": ["Car"], "attributes": ["speed"]}],
                   "operations": ["query_entities", "retrieve_entity"]})
        );
    }

    /// Plan 2.1 `id`: a slug longer than a view id is refused with the reason, not cut.
    #[test]
    fn a_slug_over_63_characters_is_refused() {
        let long = "a".repeat(64);
        let s = sources(vec![("cars", cars())]);
        let reason = view_of(&s, &endpoint(json!({"slug": long}))).expect_err("refused");
        assert!(reason.contains("64 characters"), "{reason}");
        assert!(owned(SLUG) && owned("cs-city-air") && owned(&"a".repeat(63)));
        assert!(!owned("my-view") && !owned(&long) && !owned("k4y7pq2mzt6vhx3nbwrs5cjda"));
    }

    /// Plan 2.1 `selector`, `rules`: a projection's classes and slots, less the hidden
    /// Attributes; a class whose every slot is hidden is left out; the filter is copied.
    #[test]
    fn a_projection_gives_classes_slots_and_filter() {
        let mut s = sources(vec![("cars", cars())]);
        s.projections.insert(
            ("city".into(), "cars-only".into()),
            serde_json::from_value(json!({
                "contextSpaceRef": "air", "dataModelRef": {"name": "air", "version": "1.0.0"},
                "classes": [{"name": "Car", "slots": ["speed", "owner"]},
                            {"name": "Bus", "slots": ["speed", "owner"]},
                            {"name": "Note", "slots": ["owner"]}],
                "filter": {"q": "speed>0", "scopeQ": "/city/#",
                           "geoQ": "georel=near;maxDistance==2000;geometry=Point;coordinates=[1,2]"}
            }))
            .expect("a projection"),
        );
        let e = endpoint(json!({
            "projectionRef": {"kind": "ModelProjection", "name": "cars-only"},
            "projection": {"hiddenAttributes": ["owner"]}
        }));
        let view = view_of(&s, &e).expect("a view");
        assert_eq!(view["selector"], json!(["Bus", "Car"]));
        assert_eq!(
            view["rules"],
            json!([{"types": ["Bus", "Car"], "attributes": ["speed"]}])
        );
        assert_eq!(view["q"], json!("speed>0"));
        assert_eq!(view["scopeQ"], json!("/city/#"));
        assert_eq!(
            view["geoQ"],
            json!({"georel": "near;maxDistance==2000", "geometry": "Point", "coordinates": "[1,2]"})
        );
    }

    /// `sources` with `policies` and an Endpoint narrowed by a projection whose `temporalQ` is
    /// `window`, beside one not narrowed in time.
    fn windowed(policies: Vec<(&str, PolicySpec)>, window: &str) -> (Sources, EndpointSource) {
        let mut s = sources(policies);
        s.projections.insert(
            ("city".into(), "recent".into()),
            serde_json::from_value(json!({
                "contextSpaceRef": "air", "dataModelRef": {"name": "air", "version": "1.0.0"},
                "classes": [{"name": "Car", "slots": ["speed"]}],
                "filter": {"temporalQ": window}
            }))
            .expect("a projection"),
        );
        let e = endpoint(json!({"projectionRef": {"kind": "ModelProjection", "name": "recent"}}));
        s.endpoints = vec![
            e.clone(),
            endpoint_named("plain", json!({"slug": "b".repeat(26)})),
        ];
        (s, e)
    }

    fn temporal_q(document: &Value, id: &str) -> Value {
        document["policies"]
            .as_array()
            .and_then(|all| all.iter().find(|p| p["id"] == id))
            .map_or(Value::Null, |p| {
                p.get("temporalQ").cloned().unwrap_or(Value::Null)
            })
    }

    /// T-3812 (G6, T-3632): a projection's `temporalQ` narrows each permit bound to the view, a
    /// permit's own window intersected with it (sent back: a wider own window served its whole
    /// width); a prohibition keeps its id and every time, and the view is written.
    #[test]
    fn a_projection_temporal_q_is_the_window_of_the_views_permits() {
        let own = |q: &str| {
            policy(json!({"temporalQ": q, "information": [{"entities": [{"type": "Car"}]}]}))
        };
        let no_trucks = policy(json!({"effect": "prohibition",
                                      "information": [{"entities": [{"type": "Truck"}]}]}));
        let (s, e) = windowed(
            vec![
                ("cars", cars()),
                ("month", own("timerel=after;timeAt=P-30D")),
                ("day", own("timerel=after;timeAt=PT-24H")),
                ("no-trucks", no_trucks),
            ],
            "timerel=after;timeAt=P-7D",
        );
        assert_eq!(
            view_of(&s, &e).err(),
            None,
            "the Endpoint is served by its view"
        );

        let document = &desired(&s).documents["city-air"].1;
        let copy = |name: &str| format!("city/{name}@{SLUG}");
        assert_eq!(
            document["views"],
            json!({ SLUG: [copy("cars"), copy("month"), copy("day"), "city/no-trucks"] }),
            "a view without a window and without a policyRef stays unlisted"
        );
        assert_eq!(
            temporal_q(document, &copy("cars")),
            "timerel=after;timeAt=P-7D"
        );
        assert_eq!(
            temporal_q(document, &copy("month")),
            "timerel=after;timeAt=P-7D",
            "a wider own window is cut to the projection's"
        );
        assert_eq!(
            temporal_q(document, &copy("day")),
            "timerel=after;timeAt=PT-24H"
        );
        assert_eq!(
            temporal_q(document, "city/cars"),
            Value::Null,
            "the Policy is unchanged"
        );
        assert_eq!(
            temporal_q(document, "city/month"),
            "timerel=after;timeAt=P-30D"
        );
        assert_eq!(temporal_q(document, "city/no-trucks"), Value::Null);
    }

    /// T-3812: two windows whose ends cannot be ordered, or a window that does not parse, refuse
    /// the view, and the rule document grants nothing through it.
    #[test]
    fn windows_that_cannot_be_intersected_refuse_the_view() {
        let fixed = policy(
            json!({"temporalQ": "timerel=after;timeAt=2026-01-01T00:00:00Z",
                                  "information": [{"entities": [{"type": "Car"}]}]}),
        );
        let (s, e) = windowed(vec![("fixed", fixed)], "timerel=after;timeAt=P-7D");
        let why = view_of(&s, &e).expect_err("refused");
        assert!(why.contains("cannot be compared"), "{why}");
        assert_eq!(
            desired(&s).documents["city-air"].1["views"],
            json!({ SLUG: [] })
        );

        let (s, e) = windowed(vec![("cars", cars())], "timerel=after;timeAt=P-1M");
        assert!(view_of(&s, &e).is_err(), "months have no fixed length");
    }

    /// T-3812: the later start and the earlier end, as the engine reads them.
    #[test]
    fn two_windows_intersect_to_the_later_start_and_the_earlier_end() {
        let between = "timerel=between;timeAt=2025-01-01T00:00:00Z;endTimeAt=2026-01-01T00:00:00Z";
        for (projection, own, want) in [
            (
                "timerel=after;timeAt=P-7D",
                None,
                "timerel=after;timeAt=P-7D",
            ),
            (
                "timerel=after;timeAt=-P7D",
                Some("timerel=after;timeAt=P-1W1D"),
                "timerel=after;timeAt=-P7D",
            ),
            (
                "timerel=after;timeAt=P-7D",
                Some("timerel=before;timeAt=P-1D"),
                "timerel=between;timeAt=P-7D;endTimeAt=P-1D",
            ),
            (
                between,
                Some("timerel=after;timeAt=2025-06-01T00:00:00Z"),
                "timerel=between;timeAt=2025-06-01T00:00:00Z;endTimeAt=2026-01-01T00:00:00Z",
            ),
            (
                between,
                Some("timerel=before;timeAt=2025-03-01T00:00:00+01:00"),
                "timerel=between;timeAt=2025-01-01T00:00:00Z;endTimeAt=2025-03-01T00:00:00+01:00",
            ),
        ] {
            assert_eq!(
                intersect(projection, own).as_deref(),
                Ok(want),
                "{projection} {own:?}"
            );
        }
        for (projection, own) in [
            (
                "timerel=after;timeAt=P-7D",
                Some("timerel=after;timeAt=2025-01-01T00:00:00Z"),
            ),
            ("timerel=after;timeAt=P7D", None),
            ("timerel=after;timeAt=P-1Y", None),
            ("timerel=after;timeAt=P-", None),
            ("timerel=during;timeAt=P-1D", None),
            ("timerel=between;timeAt=P-1D", None),
            ("timerel=after;timeAt=P-1D;geometry=Point", None),
        ] {
            assert!(intersect(projection, own).is_err(), "{projection} {own:?}");
        }
    }

    fn vehicles_ir() -> Value {
        json!({"version": 2, "sourceClass": "Car", "targetClass": "Vehicle",
               "slots": [{"target": "velocity", "source": "speed", "kind": "rename"}]})
    }

    fn with_mapping(policies: Vec<(&str, PolicySpec)>, ir: Result<Value, String>) -> Sources {
        let mut s = fleet(sources(policies));
        s.mappings.insert(
            ("city".into(), "to-vehicle".into()),
            MappingSource {
                space: "air".into(),
                ir,
            },
        );
        s
    }

    fn mapped_endpoint() -> EndpointSource {
        endpoint(json!({"viewMappingRef": {"kind": "Mapping", "name": "to-vehicle"}}))
    }

    /// Plan 2.1 `mapping` (G18): the Mapping's IR as the view's `mapping`, the target class
    /// swapped for the source class in `selector` and every rule, Attribute names kept, and
    /// only the reads a mapped view serves: a write the Policies grant does not reach it.
    #[test]
    fn an_endpoint_with_a_mapping_gets_the_view_with_its_ir_and_source_types() {
        let vehicles = policy(json!({
            "operations": ["retrieveOps", "createEntity", "updateAttrs", "queryTemporal", "queryBatch"],
            "information": [{"entities": [{"type": "Vehicle"}], "propertyNames": ["speed"]}]
        }));
        let s = with_mapping(vec![("vehicles", vehicles)], Ok(vehicles_ir()));
        let view = view_of(&s, &mapped_endpoint()).expect("a view");
        assert_eq!(
            view,
            json!({"id": SLUG, "tenant": "city-air", "selector": ["Car"],
                   "rules": [{"types": ["Car"], "attributes": ["speed"]}],
                   "operations": ["query_entities", "retrieve_entity", "temporal_query"],
                   "mapping": vehicles_ir()})
        );
        for op in view["operations"].as_array().into_iter().flatten() {
            assert!(
                MAPPED_READS.contains(&op.as_str().unwrap_or_default()),
                "{op}"
            );
        }
    }

    /// A Mapping the view cannot carry is the Endpoint's status, never a view.
    #[test]
    fn a_mapping_without_an_ir_is_a_status_not_a_view() {
        let vehicles = || policy(json!({"information": [{"entities": [{"type": "Vehicle"}]}]}));
        let cases = [
            (
                with_mapping(
                    vec![("v", vehicles())],
                    Err("the Mapping to-vehicle has no spec.artifacts.gatewayIr".into()),
                ),
                mapped_endpoint(),
                "gatewayIr",
            ),
            (
                with_mapping(vec![("v", vehicles())], Ok(json!({"version": 2}))),
                mapped_endpoint(),
                "names no targetClass",
            ),
            (
                with_mapping(vec![("v", vehicles())], Ok(vehicles_ir())),
                endpoint(json!({"viewMappingRef": {"kind": "Mapping", "name": "absent"}})),
                "no Mapping of this Context Space",
            ),
            (
                with_mapping(
                    vec![
                        ("v", vehicles()),
                        (
                            "buses",
                            policy(json!({"information": [{"entities": [{"type": "Bus"}]}]})),
                        ),
                    ],
                    Ok(vehicles_ir()),
                ),
                mapped_endpoint(),
                "Policies also name Bus",
            ),
            (
                with_mapping(
                    vec![(
                        "w",
                        policy(json!({"operations": ["createEntity"],
                                      "information": [{"entities": [{"type": "Vehicle"}]}]})),
                    )],
                    Ok(vehicles_ir()),
                ),
                mapped_endpoint(),
                "no read",
            ),
        ];
        for (s, e, reason) in cases {
            let got = view_of(&s, &e).expect_err("refused");
            assert!(got.contains(reason), "{reason}: {got}");
        }
        let mut elsewhere = with_mapping(vec![("v", vehicles())], Ok(vehicles_ir()));
        for m in elsewhere.mappings.values_mut() {
            m.space = "water".into();
        }
        assert!(view_of(&elsewhere, &mapped_endpoint())
            .expect_err("refused")
            .contains("no Mapping of this Context Space"));
        let mut unservable = with_mapping(vec![("v", vehicles())], Err("no IR".into()));
        unservable.endpoints.push(mapped_endpoint());
        let desired = desired(&unservable);
        assert!(!desired.views.contains_key(SLUG));
        assert!(desired
            .refused
            .iter()
            .any(|(owner, reason)| owner.name == "air-public" && reason == "no IR"));
    }

    /// Plan 2.1 `rules`: types the Policies grant with the same Attributes share a rule; a
    /// type granted whole by one Policy is whole; a Policy without information is the model's
    /// classes; hidden Attributes on a whole type are refused rather than shown.
    #[test]
    fn policies_union_into_rules() {
        let s = fleet(sources(vec![
            ("cars", cars()),
            (
                "buses",
                policy(json!({"information": [{"entities": [{"type": "Bus"}],
                                               "propertyNames": ["speed"]},
                                              {"entities": [{"type": "Car"}],
                                               "relationshipNames": ["ownedBy"]}]})),
            ),
            (
                "stops",
                policy(json!({"information": [{"entities": [{"type": "Stop"}]}]})),
            ),
        ]));
        let view = view_of(&s, &endpoint(json!({}))).expect("a view");
        assert_eq!(
            view["rules"],
            json!([{"types": ["Stop"], "attributes": ["location", "name"]},
                   {"types": ["Car"], "attributes": ["ownedBy", "speed"]},
                   {"types": ["Bus"], "attributes": ["speed"]}])
        );
    }

    /// T-3788: a type shown whole lists its class's slots (Antares reads `[]` as no
    /// Attribute), less the hidden ones; a whole type the model has no class for is refused,
    /// and so is every whole type when the space's model does not read.
    #[test]
    fn a_type_shown_whole_lists_its_classes_slots() {
        let whole = |types: &[&str]| {
            let entities: Vec<Value> = types.iter().map(|t| json!({"type": t})).collect();
            policy(json!({"information": [{"entities": entities}]}))
        };
        let s = fleet(sources(vec![("all", whole(&["Car", "Stop"]))]));
        let view = view_of(&s, &endpoint(json!({}))).expect("a view");
        assert_eq!(
            view["rules"],
            json!([{"types": ["Stop"], "attributes": ["location", "name"]},
                   {"types": ["Car"], "attributes": ["ownedBy", "speed"]}])
        );
        let hidden = endpoint(json!({"projection": {"hiddenAttributes": ["name", "ownedBy"]}}));
        assert_eq!(
            view_of(&s, &hidden).expect("a view")["rules"],
            json!([{"types": ["Stop"], "attributes": ["location"]},
                   {"types": ["Car"], "attributes": ["speed"]}])
        );
        let tram = fleet(sources(vec![("trams", whole(&["Car", "Tram"]))]));
        let reason = view_of(&tram, &endpoint(json!({}))).expect_err("refused");
        assert!(
            reason.contains("Tram is shown whole") && reason.contains("no class Tram"),
            "{reason}"
        );
        for model in [None, Some(Err("does not read".to_owned()))] {
            let mut s = fleet(sources(vec![("all", whole(&["Car"]))]));
            s.models.remove(&("city".into(), "air".into()));
            s.models
                .extend(model.map(|m| (("city".into(), "air".into()), m)));
            let reason = view_of(&s, &endpoint(json!({}))).expect_err("refused");
            assert!(reason.contains("Car is shown whole"), "{reason}");
        }
        let projection = {
            let mut s = fleet(sources(vec![("cars", cars())]));
            s.projections.insert(
                ("city".into(), "all".into()),
                serde_json::from_value(json!({
                    "contextSpaceRef": "air", "dataModelRef": {"name": "air", "version": "1.0.0"},
                    "classes": [{"name": "Bus"}]
                }))
                .expect("a projection"),
            );
            s
        };
        let bus = endpoint(json!({"projectionRef": {"kind": "ModelProjection", "name": "all"}}));
        assert_eq!(
            view_of(&projection, &bus).expect("a view")["rules"],
            json!([{"types": ["Bus"], "attributes": ["speed"]}]),
            "a projection class without slots is the class whole"
        );
    }

    #[test]
    fn a_classless_or_cyclic_model_reads_as_it_is() {
        let model = parsed(&fleet_model());
        assert_eq!(
            class_slots(&model, "Vehicle"),
            Some(["speed".to_owned()].into())
        );
        assert_eq!(
            class_slots(&model, "Located"),
            Some(["location".to_owned()].into())
        );
        assert_eq!(class_slots(&model, "Tram"), None);
        let odd = parsed(&ModelSource {
            model: "odd".into(),
            source: "classes:\n  A: {is_a: B, mixins: Gone, slots: [x]}\n  B: {is_a: A, attributes: [y]}\n".into(),
            imports: BTreeMap::from([("broken".to_owned(), "classes: [".to_owned())]),
        });
        assert_eq!(
            class_slots(&odd, "A"),
            Some(["x".to_owned(), "y".to_owned()].into()),
            "a cycle ends, a missing mixin is skipped, a list of attributes reads"
        );
    }

    /// A permission without `information` grants the space model's classes, each whole.
    #[test]
    fn a_policy_without_information_grants_the_models_classes() {
        let mut every = fleet(sources(vec![("all", policy(json!({})))]));
        assert!(
            view_of(&every, &endpoint(json!({}))).is_err(),
            "no class to select"
        );
        every.classes.insert(
            ("city".into(), "air".into()),
            ["Car".to_owned(), "Bus".to_owned()].into(),
        );
        let view = view_of(&every, &endpoint(json!({}))).expect("a view");
        assert_eq!(view["selector"], json!(["Bus", "Car"]));
    }

    /// Plan 2.1 `selector`: over 256 types is refused, not truncated.
    #[test]
    fn over_256_types_is_refused() {
        let entities: Vec<Value> = (0..257).map(|n| json!({"type": format!("T{n}")})).collect();
        let s = sources(vec![(
            "many",
            policy(json!({"information": [{"entities": entities, "propertyNames": ["a"]}]})),
        )]);
        let reason = view_of(&s, &endpoint(json!({}))).expect_err("refused");
        assert!(reason.contains("257 types"), "{reason}");
    }

    /// Plan 2.1 `operations`: groups expanded, each name to the rows of its clause; purge and
    /// Entity Maps never enter a view; a prohibition grants no operation; a Policy that grants
    /// only what no view serves leaves nothing to write.
    #[test]
    fn operations_map_to_matrix_rows() {
        let s = fleet(sources(vec![
            (
                "write",
                policy(
                    json!({"operations": ["queryBatch", "updateAttrs", "purgeEntity",
                                             "retrieveEntityMap", "queryTemporal"],
                              "information": [{"entities": [{"type": "Car"}]}]}),
                ),
            ),
            (
                "deny",
                policy(
                    json!({"effect": "prohibition", "operations": ["deleteEntity"],
                              "information": [{"entities": [{"type": "Car"}]}]}),
                ),
            ),
        ]));
        let view = view_of(&s, &endpoint(json!({}))).expect("a view");
        assert_eq!(
            view["operations"],
            json!([
                "partial_attribute_update",
                "query_entities_post",
                "temporal_query",
                "temporal_query_post"
            ])
        );
        let only_maps = fleet(sources(vec![(
            "maps",
            policy(json!({"operations": ["retrieveEntityMap"],
                          "information": [{"entities": [{"type": "Car"}]}]})),
        )]));
        assert!(view_of(&only_maps, &endpoint(json!({})))
            .expect_err("refused")
            .contains("no operation"));
        let none = fleet(sources(vec![]));
        assert!(view_of(&none, &endpoint(json!({})))
            .expect_err("refused")
            .contains("no Policy"));
    }

    /// Every Table 4.20-1 name has its clause; only Query Entities has two names.
    #[test]
    fn every_operation_has_a_clause() {
        let mut clauses: BTreeMap<&str, Vec<Operation>> = BTreeMap::new();
        for op in Operation::ALL {
            clauses.entry(operation(*op).0).or_default().push(*op);
        }
        assert_eq!(clauses.len(), Operation::ALL.len() - 1);
        assert_eq!(
            clauses["5.7.2"],
            [Operation::QueryEntity, Operation::QueryBatch]
        );
    }

    /// Plan 2.1 `policyRef`: the one Policy it names, of this space; another space's binds
    /// nothing. An App's Endpoint keeps its own grants and the prohibitions (AP-139).
    #[test]
    fn policy_ref_and_app_endpoints_bind_as_the_gateway_does() {
        let own = jc_core::kinds::endpoint_role("city", "app-map", None);
        let s = {
            let mut s = fleet(sources(vec![
                ("cars", cars()),
                (
                    "buses",
                    policy(json!({"information": [{"entities": [{"type": "Bus"}]}]})),
                ),
                (
                    "mine",
                    policy(json!({"assignee": {"kind": "role", "id": own},
                                  "information": [{"entities": [{"type": "Stop"}]}]})),
                ),
            ]));
            s.apps.insert(("city".into(), "map".into()));
            s
        };
        let bound =
            endpoint(json!({"policyRef": "urn:ngsi-ld:Policy:city.example:city-air:buses"}));
        assert_eq!(
            view_of(&s, &bound).expect("a view")["selector"],
            json!(["Bus"])
        );
        let elsewhere =
            endpoint(json!({"policyRef": "urn:ngsi-ld:Policy:city.example:other:buses"}));
        assert!(view_of(&s, &elsewhere).is_err());
        let app = endpoint_named("app-map", json!({}));
        assert_eq!(
            view_of(&s, &app).expect("a view")["selector"],
            json!(["Stop"])
        );
    }

    /// T-3702: the rule document lists, per Endpoint view that binds fewer than all the
    /// space's Policies, the ids it is decided by: `policyRef` its one Policy (another space's
    /// binds none), an App's Endpoint its own grants and the prohibitions. An Endpoint binding
    /// every Policy is not listed, so the engine decides it with all of them.
    #[test]
    fn the_rule_document_lists_the_policies_each_bound_view_is_decided_by() {
        let own = jc_core::kinds::endpoint_role("city", "app-map", None);
        let mut s = sources(vec![
            ("cars", cars()),
            (
                "buses",
                policy(json!({"information": [{"entities": [{"type": "Bus"}]}]})),
            ),
            (
                "mine",
                policy(json!({"assignee": {"kind": "role", "id": own},
                              "information": [{"entities": [{"type": "Stop"}]}]})),
            ),
            (
                "no-trucks",
                policy(json!({"effect": "prohibition",
                              "information": [{"entities": [{"type": "Truck"}]}]})),
            ),
        ]);
        s.apps.insert(("city".into(), "map".into()));
        let slug = |c: char| c.to_string().repeat(26);
        let with_slug = |name: &str, c: char, mut extra: Value| {
            if let Some(o) = extra.as_object_mut() {
                o.insert("slug".into(), json!(slug(c)));
            }
            endpoint_named(name, extra)
        };
        s.endpoints = vec![
            with_slug("air-public", 'a', json!({})),
            with_slug(
                "buses-only",
                'b',
                json!({"policyRef": "urn:ngsi-ld:Policy:city.example:city-air:buses"}),
            ),
            with_slug(
                "elsewhere",
                'c',
                json!({"policyRef": "urn:ngsi-ld:Policy:city.example:other:buses"}),
            ),
            with_slug("app-map", 'd', json!({})),
        ];
        let document = &desired(&s).documents["city-air"].1;
        assert_eq!(
            document["views"],
            json!({
                slug('b'): ["city/buses"],
                slug('c'): [],
                slug('d'): ["city/mine", "city/no-trucks"],
            })
        );
    }

    /// T-3788: the space view is the `*` form, every type and Attribute; the engine narrows
    /// it per subject. Its operations are the space's grants.
    #[test]
    fn the_space_view_is_the_star_form() {
        let s = sources(vec![("cars", cars())]);
        let view = space_view(&s, "city", "air", "city-air").expect("a view");
        assert_eq!(
            view,
            json!({"id": "cs-city-air", "tenant": "city-air", "selector": ["*"],
                   "rules": [{"types": ["*"], "attributes": ["*"]}],
                   "operations": ["query_entities", "retrieve_entity"]})
        );
        let long = "x".repeat(61);
        assert!(space_view(&s, "city", "air", &long).is_err());
        assert!(
            space_view(&sources(Vec::new()), "city", "air", "city-air").is_err(),
            "no grant, no operation"
        );
    }

    /// T-3767: a space with no Policy still admits the gateway's own hops, and only on the
    /// clauses they use; nothing else in the document names the gateway.
    #[test]
    fn every_rule_document_admits_the_gateway_on_its_own_hops_alone() {
        let desired = desired(&sources(Vec::new()));
        assert_eq!(
            desired.documents["city-air"].1,
            json!({"policies": [
                {"id": "@context-gateway", "effect": "permit",
                 "assignee": {"kind": "serviceAccount", "id": "context-gateway"},
                 "operations": ["5.6.4", "5.6.5", "5.6.6", "5.7.1", "5.7.2", "5.7.5", "5.8.3"]}
            ]})
        );
    }

    /// Plan 3.3: one document per tenant, every Policy with its clauses, effect, assignee,
    /// validity, information and conditions, in the engine's format.
    #[test]
    fn the_rule_document_carries_every_policy() {
        let s = sources(vec![
            ("cars", cars()),
            (
                "no-trucks",
                policy(
                    json!({"effect": "prohibition", "operations": ["updateOps", "updateAttrs"],
                              "assignee": {"kind": "group", "id": "drivers"},
                              "information": [{"entities": [{"type": "Truck",
                                                             "idPattern": "^urn:ngsi-ld:Truck:.*$"}]}],
                              "q": "weight>3", "scopeQ": "/city/#", "temporalQ": "timerel=after;timeAt=P-1D",
                              "validity": {"from": "2026-01-01T00:00:00Z"}}),
                ),
            ),
        ]);
        let desired = desired(&s);
        let (owner, document) = &desired.documents["city-air"];
        assert_eq!(owner, &Owner::space("city", "air"));
        assert_eq!(
            document,
            &json!({"policies": [
                {"id": "city/cars", "effect": "permit", "assignee": {"kind": "role", "id": "public"},
                 "operations": ["5.7.1", "5.7.2"],
                 "information": [{"entities": [{"type": "Car"}], "propertyNames": ["speed"]}]},
                {"id": "city/no-trucks", "effect": "prohibit", "assignee": {"kind": "group", "id": "drivers"},
                 "operations": ["5.6.2", "5.6.4", "5.6.18", "5.6.19"],
                 "validity": {"from": "2026-01-01T00:00:00Z"},
                 "information": [{"entities": [{"type": "Truck", "idPattern": "^urn:ngsi-ld:Truck:.*$"}]}],
                 "q": "weight>3", "scopeQ": "/city/#", "temporalQ": "timerel=after;timeAt=P-1D"},
                {"id": "@context-gateway", "effect": "permit",
                 "assignee": {"kind": "serviceAccount", "id": "context-gateway"},
                 "operations": ["5.6.4", "5.6.5", "5.6.6", "5.7.1", "5.7.2", "5.7.5", "5.8.3"]}
            ]})
        );
        assert!(desired.views.contains_key(SLUG) || desired.views.contains_key("cs-city-air"));
    }

    #[test]
    fn a_geo_query_without_its_members_is_refused() {
        for bad in [
            "georel=within;geometry=Point",
            "maxDistance==1;georel=near;geometry=Point;coordinates=[1,2]",
            "georel=within;geometry=Point;coordinates=[1,2];shape=x",
        ] {
            assert!(geo(bad).is_err(), "{bad}");
        }
    }

    /// The tenant is the space's rendered segment and the derived Policies are read, from a
    /// repository loaded the way the reconciler loads it.
    #[test]
    fn sources_read_a_loaded_repository() {
        let dir = std::env::temp_dir().join(format!(
            "portal-views-read-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        let write = |rel: &str, body: &str| {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
            std::fs::write(path, body).expect("write");
        };
        let head = |kind: &str, name: &str| {
            format!("apiVersion: joinedcontext.com/v1alpha1\nkind: {kind}\nmetadata:\n  name: {name}\n  namespace: city\nspec:\n")
        };
        write(
            "projects/city/spaces/air/space.yaml",
            &format!(
                "{}  isSandbox: false\n  urnSegment: luft\n",
                head("ContextSpace", "air")
            ),
        );
        write(
            "projects/city/spaces/air/endpoints/air-public.yaml",
            &format!("{}  contextSpaceRef: air\n  slug: {SLUG}\n  audience: public\n  enabledRepresentations: [ngsi-ld]\n", head("Endpoint", "air-public")),
        );
        write(
            "projects/city/spaces/air/policies/cars.yaml",
            &format!("{}  contextSpaceRef: air\n  assigner: did:web:city.example\n  assignee: {{ kind: role, id: public }}\n  operations: [retrieveOps]\n  information:\n    - entities: [{{ type: Car }}]\n      propertyNames: [speed]\n", head("Policy", "cars")),
        );
        let mapping = |name: &str, artifacts: &str| {
            format!("{}  contextSpaceRef: air\n  source: {{ kind: DataModel, name: cars, version: \"1\" }}\n  target: {{ kind: DataModel, name: vehicles, version: \"1\" }}\n  transformation: {{ id: https://city.example/m }}\n  tests: [{{ input: in.json, expect: out.json }}]\n{artifacts}", head("Mapping", name))
        };
        write(
            "projects/city/spaces/air/mappings/to-vehicle.yaml",
            &mapping(
                "to-vehicle",
                "  artifacts: { gatewayIr: ir/to-vehicle.json }\n",
            ),
        );
        write(
            "projects/city/spaces/air/mappings/ir/to-vehicle.json",
            &vehicles_ir().to_string(),
        );
        write(
            "projects/city/spaces/air/mappings/bare.yaml",
            &mapping("bare", ""),
        );
        write(
            "projects/city/spaces/air/mappings/escapes.yaml",
            &mapping("escapes", "  artifacts: { gatewayIr: ir/missing.json }\n"),
        );
        let repo = Repository::load(&dir).expect("the repository loads");
        let read = Sources::read(&repo);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read.spaces, [("city".into(), "air".into(), "luft".into())]);
        assert_eq!(read.endpoints.len(), 1);
        assert_eq!(read.endpoints[0].tenant, "luft");
        let desired = desired(&read);
        assert_eq!(desired.views[SLUG].1["tenant"], json!("luft"));
        assert!(desired.views.contains_key("cs-luft"));
        assert_eq!(
            desired.documents["luft"].1["policies"][0]["id"],
            json!("city/cars")
        );
        let ir = |name: &str| {
            read.mappings[&("city".to_owned(), name.to_owned())]
                .ir
                .clone()
        };
        assert_eq!(ir("to-vehicle"), Ok(vehicles_ir()));
        assert!(ir("bare").is_err_and(|e| e.contains("has no spec.artifacts.gatewayIr")));
        assert!(ir("escapes").is_err_and(|e| e.contains("no JSON file")));
        assert_eq!(
            read.mappings[&("city".to_owned(), "bare".to_owned())].space,
            "air"
        );
    }

    const TOKEN: &str = "an-admin-token-of-at-least-32-bytes!";

    fn token_file() -> PathBuf {
        let file = std::env::temp_dir().join(format!(
            "portal-views-token-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::write(&file, format!("{TOKEN}\n")).expect("write the token");
        file
    }

    async fn broker() -> MockServer {
        MockServer::start().await
    }

    fn json_at(server_path: &str, status: u16, body: Value) -> Mock {
        Mock::given(method("GET"))
            .and(path(server_path))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
    }

    /// The writer against the broker's `/q`: a new view is written, an unchanged one is not
    /// sent again, a changed one is replaced, an owned one that is gone is deleted, a view
    /// written by hand is left alone, a refused Endpoint is reported without a call, a broker
    /// 400 lands in the outcome with its detail, the rule document is written, and every call
    /// carries the token, which no outcome repeats.
    #[tokio::test]
    async fn the_writer_converges_the_brokers_views_and_documents() {
        let server = broker().await;
        let gone = "zzzzzzzzzzzzzzzzzzzzzzzzzz";
        let s = {
            let mut s = sources(vec![("cars", cars())]);
            s.endpoints.push(endpoint(json!({})));
            s.endpoints.push(endpoint_named(
                "mapped",
                json!({"slug": "m3mqavzt5xkc2nhw7brj4gd6sy",
                       "viewMappingRef": {"kind": "Mapping", "name": "m"}}),
            ));
            s.endpoints.push(endpoint_named(
                "refused-by-broker",
                json!({"slug": "p3mqavzt5xkc2nhw7brj4gd6sy"}),
            ));
            s
        };
        let desired = desired(&s);
        let space_view = desired.views["cs-city-air"].1.clone();
        let document = desired.documents["city-air"].1.clone();

        json_at(
            "/q/views",
            200,
            json!({"cs-city-air": {"state": "loaded"}, gone: {"state": "loaded"},
                   "my-view": {"state": "loaded"}}),
        )
        .mount(&server)
        .await;
        json_at(&format!("/q/views/{SLUG}"), 404, json!({}))
            .mount(&server)
            .await;
        json_at("/q/views/cs-city-air", 200, space_view)
            .mount(&server)
            .await;
        json_at(
            "/q/views/p3mqavzt5xkc2nhw7brj4gd6sy",
            200,
            json!({"id": "old"}),
        )
        .mount(&server)
        .await;
        json_at("/q/policy", 200, json!({"loaded": [], "refused": []}))
            .mount(&server)
            .await;
        json_at("/q/policy/city-air", 404, json!({}))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path(format!("/q/views/{SLUG}")))
            .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/views/cs-city-air"))
            .respond_with(ResponseTemplate::new(204))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/views/p3mqavzt5xkc2nhw7brj4gd6sy"))
            .respond_with(ResponseTemplate::new(400).set_body_json(
                json!({"type": "https://uri.etsi.org/ngsi-ld/errors/BadRequestData",
                       "detail": "rules[0].types: \"Car\" is wrong"}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path(format!("/q/views/{gone}")))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/q/views/my-view"))
            .respond_with(ResponseTemplate::new(204))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/policy/city-air"))
            .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
            .and(body_json(&document))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        let file = token_file();
        let sync = ViewSync::new(server.uri(), &file);
        let outcomes: BTreeMap<String, ViewOutcome> = sync
            .apply(desired)
            .await
            .into_iter()
            .map(|(owner, outcome)| (owner.name, outcome))
            .collect();
        let _ = std::fs::remove_file(&file);

        assert_eq!(outcomes["air-public"], ViewOutcome::Written);
        assert_eq!(outcomes["air"], ViewOutcome::Written);
        assert!(
            matches!(&outcomes["mapped"], ViewOutcome::Refused(r) if r.contains("viewMappingRef")),
            "{outcomes:?}"
        );
        assert!(
            matches!(&outcomes["refused-by-broker"],
                     ViewOutcome::Failed(r) if r.contains("400") && r.contains("is wrong")),
            "{outcomes:?}"
        );
        assert!(!format!("{outcomes:?}").contains(TOKEN));
        assert!(sync.written().contains("city-air"));
    }

    /// A rule document whose space is gone is deleted; one the broker already holds is not
    /// sent again; a broker without a document-reading engine gets views only.
    #[tokio::test]
    async fn rule_documents_follow_their_spaces() {
        let server = broker().await;
        let s = sources(vec![("cars", cars())]);
        let document = desired(&s).documents["city-air"].1.clone();
        json_at("/q/views", 200, json!({})).mount(&server).await;
        json_at(
            "/q/views/cs-city-air",
            200,
            desired(&s).views["cs-city-air"].1.clone(),
        )
        .mount(&server)
        .await;
        json_at("/q/policy", 200, json!({})).mount(&server).await;
        json_at(
            "/q/policy/city-air",
            200,
            json!({"tenant": "city-air", "revision": 3, "document": document}),
        )
        .mount(&server)
        .await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(204))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/q/policy/old-space"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let file = token_file();
        let sync = ViewSync::new(server.uri(), &file);
        sync.written().insert("old-space".into());
        let outcomes = sync.apply(desired(&s)).await;
        assert_eq!(
            outcomes,
            [(Owner::space("city", "air"), ViewOutcome::Written)]
        );
        assert!(!sync.written().contains("old-space"));

        let no_engine = broker().await;
        json_at("/q/views", 200, json!({})).mount(&no_engine).await;
        json_at("/q/views/cs-city-air", 404, json!({}))
            .mount(&no_engine)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/views/cs-city-air"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&no_engine)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/policy/city-air"))
            .respond_with(ResponseTemplate::new(201))
            .expect(0)
            .mount(&no_engine)
            .await;
        let outcomes = ViewSync::new(no_engine.uri(), &file)
            .apply(desired(&s))
            .await;
        let _ = std::fs::remove_file(&file);
        assert_eq!(
            outcomes,
            [(Owner::space("city", "air"), ViewOutcome::Written)]
        );
    }

    /// Without a readable token nothing is sent and every object says why, naming the file and
    /// never a token.
    #[tokio::test]
    async fn without_the_token_nothing_is_sent() {
        let server = broker().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let sync = ViewSync::new(server.uri(), "/nonexistent/broker-admin-token");
        let outcomes = sync.apply(desired(&sources(vec![("cars", cars())]))).await;
        assert!(
            matches!(&outcomes[..], [(_, ViewOutcome::Failed(r))] if r.contains("/nonexistent/broker-admin-token")),
            "{outcomes:?}"
        );
    }

    /// Two Endpoints with one slug, or two spaces rendering one tenant: the second is refused
    /// and the first keeps its view and document.
    #[test]
    fn a_second_owner_of_a_slug_or_tenant_is_refused() {
        let mut s = sources(vec![("cars", cars())]);
        s.endpoints.push(endpoint(json!({})));
        s.endpoints.push(endpoint_named("copy", json!({})));
        s.spaces
            .push(("other".into(), "air".into(), "city-air".into()));
        let d = desired(&s);
        assert_eq!(d.views[SLUG].0.name, "air-public");
        assert_eq!(d.documents["city-air"].0.project, "city");
        let refused: Vec<(&str, &str)> = d
            .refused
            .iter()
            .map(|(owner, reason)| (owner.name.as_str(), reason.as_str()))
            .collect();
        assert!(
            refused
                .iter()
                .any(|(n, r)| *n == "copy" && r.contains("same slug")),
            "{refused:?}"
        );
        assert!(
            refused
                .iter()
                .any(|(n, r)| *n == "air" && r.contains("same tenant")),
            "{refused:?}"
        );
    }

    /// An empty repository wants nothing: every owned view goes, a hand-made one stays, and
    /// there is no outcome to report.
    #[tokio::test]
    async fn an_empty_repository_removes_every_owned_view() {
        let server = broker().await;
        json_at(
            "/q/views",
            200,
            json!({SLUG: {}, "cs-city-air": {}, "my-view": {}}),
        )
        .mount(&server)
        .await;
        json_at("/q/policy", 404, json!({})).mount(&server).await;
        for (id, times) in [(SLUG, 1), ("cs-city-air", 1), ("my-view", 0)] {
            Mock::given(method("DELETE"))
                .and(path(format!("/q/views/{id}")))
                .respond_with(ResponseTemplate::new(204))
                .expect(times)
                .mount(&server)
                .await;
        }
        let file = token_file();
        let outcomes = ViewSync::new(server.uri(), &file)
            .apply(desired(&Sources::default()))
            .await;
        let _ = std::fs::remove_file(&file);
        assert!(outcomes.is_empty(), "{outcomes:?}");
    }

    /// A broker that does not answer, or one without the views feature, fails every object
    /// with the reason and writes nothing.
    #[tokio::test]
    async fn a_broker_that_cannot_take_views_fails_every_object() {
        let file = token_file();
        let s = sources(vec![("cars", cars())]);
        let down = ViewSync::new("http://127.0.0.1:9", &file)
            .apply(desired(&s))
            .await;
        assert!(
            matches!(&down[..], [(_, ViewOutcome::Failed(r))] if r.contains("did not answer")),
            "{down:?}"
        );
        let vanilla = broker().await;
        json_at("/q/views", 404, json!({})).mount(&vanilla).await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(201))
            .expect(0)
            .mount(&vanilla)
            .await;
        let outcomes = ViewSync::new(vanilla.uri(), &file).apply(desired(&s)).await;
        let _ = std::fs::remove_file(&file);
        assert!(
            matches!(&outcomes[..], [(_, ViewOutcome::Failed(r))] if r.contains("views feature")),
            "{outcomes:?}"
        );
    }

    fn air_model() -> ModelSource {
        ModelSource {
            model: "air-quality".into(),
            source: "id: https://city.example/air\nname: air\nimports: [linkml:types, org.stations.v1]\n".into(),
            imports: BTreeMap::from([(
                "org.stations.v1".to_owned(),
                "id: https://city.example/stations\nname: stations\n".to_owned(),
            )]),
        }
    }

    fn with_model(mut s: Sources) -> Sources {
        s.models
            .insert(("city".into(), "air".into()), Ok(air_model()));
        s
    }

    /// T-3788 through the writer: a type a Policy grants whole reaches the broker as its
    /// class's slots, never as `"attributes": []`.
    #[tokio::test]
    async fn the_writer_puts_a_whole_type_as_its_classes_slots() {
        let mut s = fleet(sources(vec![(
            "stops",
            policy(json!({"information": [{"entities": [{"type": "Stop"}]}]})),
        )]));
        s.endpoints.push(endpoint(json!({})));
        let tools = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/generate"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"brokerSchema": {"classes": {}}, "errors": []})),
            )
            .mount(&tools)
            .await;
        let server = broker_with_the_space_view(&s).await;
        json_at("/q/schemas/city-air", 404, json!({}))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/schemas/city-air"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        json_at(&format!("/q/views/{SLUG}"), 404, json!({}))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path(format!("/q/views/{SLUG}")))
            .and(body_json(json!({
                "id": SLUG, "tenant": "city-air", "selector": ["Stop"],
                "rules": [{"types": ["Stop"], "attributes": ["location", "name"]}],
                "operations": ["query_entities", "retrieve_entity"]
            })))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        let file = token_file();
        let sync = ViewSync::new(server.uri(), &file).with_model_tools(format!("{}/", tools.uri()));
        let outcomes = sync.apply(desired(&s)).await;
        let _ = std::fs::remove_file(&file);
        let endpoint = outcomes
            .iter()
            .find(|(owner, _)| owner.kind == "Endpoint")
            .map(|(_, outcome)| outcome.clone());
        assert_eq!(endpoint, Some(ViewOutcome::Written), "{outcomes:?}");
    }

    /// The `brokerSchema` Model Tools answers for `air_model()`, as `POST /generate` takes it.
    async fn model_tools(answer: Value, calls: u64) -> MockServer {
        let tools = MockServer::start().await;
        let model = air_model();
        Mock::given(method("POST"))
            .and(path("/generate"))
            .and(body_json(
                json!({"source": model.source, "imports": model.imports}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(answer))
            .expect(calls)
            .mount(&tools)
            .await;
        tools
    }

    /// A broker that holds the space's view and runs no rule-document engine, so a run is
    /// views and schemas only.
    async fn broker_with_the_space_view(s: &Sources) -> MockServer {
        let server = broker().await;
        json_at("/q/views", 200, json!({})).mount(&server).await;
        json_at(
            "/q/views/cs-city-air",
            200,
            desired(s).views["cs-city-air"].1.clone(),
        )
        .mount(&server)
        .await;
        json_at("/q/policy", 404, json!({})).mount(&server).await;
        server
    }

    /// The space's model and its import are read from the checkout, an import at its pinned
    /// major and published; a draft import, another major and a source outside the checkout
    /// are the space's reason, not a read.
    #[test]
    fn a_spaces_model_and_its_imports_are_read_from_the_checkout() {
        let dir = std::env::temp_dir().join(format!(
            "portal-views-model-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        let write = |rel: &str, body: &str| {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
            std::fs::write(path, body).expect("write");
        };
        let manifest = |namespace: &str, space: &str, name: &str| {
            jc_core::registry::by_kind("DataModel")
                .expect("DataModel is a kind")
                .repo_path(namespace, space, name)
        };
        let model = |namespace: &str, name: &str, extra: &str| {
            format!("apiVersion: joinedcontext.com/v1alpha1\nkind: DataModel\nmetadata:\n  name: {name}\n  namespace: {namespace}\nspec:\n  linkml: ./{name}.linkml.yaml\n{extra}")
        };
        write(
            "projects/city/spaces/air/space.yaml",
            "apiVersion: joinedcontext.com/v1alpha1\nkind: ContextSpace\nmetadata:\n  name: air\n  namespace: city\nspec:\n  isSandbox: false\n  dataModelRef: air-quality\n",
        );
        let air = manifest("city", "air", "air-quality");
        write(
            &air,
            &model(
                "city",
                "air-quality",
                "  contextSpaceRef: air\n  version: 1.0.0\n  lifecycle: draft\n",
            ),
        );
        let air_source =
            "id: https://city.example/air\nname: air\nimports: [linkml:types, org.stations.v1]\n";
        let folder = air
            .rsplit_once('/')
            .map(|(f, _)| f.to_owned())
            .unwrap_or_default();
        write(&format!("{folder}/air-quality.linkml.yaml"), air_source);
        let stations = manifest(ORG_NAMESPACE, "", "stations");
        let org_folder = stations
            .rsplit_once('/')
            .map(|(f, _)| f.to_owned())
            .unwrap_or_default();
        let stations_source = "id: https://city.example/stations\nname: stations\n";
        write(
            &format!("{org_folder}/stations.linkml.yaml"),
            stations_source,
        );
        let read = |stations_spec: &str| {
            write(&stations, &model(ORG_NAMESPACE, "stations", stations_spec));
            let repo = Repository::load(&dir).expect("the repository loads");
            Sources::read(&repo).models[&("city".to_owned(), "air".to_owned())].clone()
        };

        let draft = read("  version: 1.2.0\n  lifecycle: draft\n");
        let next_major = read("  version: 2.0.0\n  lifecycle: published\n");
        let published = read("  version: 1.2.0\n  lifecycle: published\n");
        // The loader refuses a symlink out of the checkout; one that appears after the load is
        // refused when the source is read.
        let repo = Repository::load(&dir).expect("the repository loads");
        let outside = dir.with_extension("outside.linkml.yaml");
        std::fs::write(&outside, "id: https://elsewhere\n").expect("write");
        let _ = std::fs::remove_file(dir.join(format!("{org_folder}/stations.linkml.yaml")));
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            &outside,
            dir.join(format!("{org_folder}/stations.linkml.yaml")),
        )
        .expect("symlink");
        let escaped = Sources::read(&repo).models[&("city".to_owned(), "air".to_owned())].clone();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);

        assert_eq!(
            published,
            Ok(ModelSource {
                model: "air-quality".into(),
                source: air_source.into(),
                imports: BTreeMap::from([("org.stations.v1".into(), stations_source.into())]),
            })
        );
        assert!(
            matches!(&draft, Err(r) if r.contains("org.stations.v1") && r.contains("only a published model")),
            "{draft:?}"
        );
        assert!(
            matches!(&next_major, Err(r) if r.contains("pins major 1")),
            "{next_major:?}"
        );
        #[cfg(unix)]
        assert!(
            matches!(&escaped, Err(r) if r.contains("leaves the repository")),
            "{escaped:?}"
        );
        let refused = desired(&Sources {
            models: BTreeMap::from([(("city".into(), "air".into()), draft)]),
            ..sources(vec![("cars", cars())])
        })
        .refused;
        assert!(
            matches!(&refused[..], [(owner, r)] if owner.name == "air" && r.starts_with("its data model is not written to the broker: import 'org.stations.v1'")),
            "{refused:?}"
        );
    }

    /// The space's model is compiled once and written as its tenant's schema; an unchanged one
    /// is neither compiled nor sent again; a space that loses its model loses the schema.
    #[tokio::test]
    async fn a_spaces_schema_is_written_once_and_removed_with_its_model() {
        let s = with_model(sources(vec![("cars", cars())]));
        let schema: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/broker-schema-senzor.json"
        ))
        .expect("the fixture is JSON");
        let tools = model_tools(json!({"brokerSchema": schema, "errors": []}), 1).await;
        let server = broker_with_the_space_view(&s).await;
        Mock::given(method("GET"))
            .and(path("/q/schemas/city-air"))
            .respond_with(ResponseTemplate::new(404))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        json_at("/q/schemas/city-air", 200, schema.clone())
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/schemas/city-air"))
            .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
            .and(body_json(&schema))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/q/schemas/city-air"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let file = token_file();
        let sync = ViewSync::new(server.uri(), &file).with_model_tools(format!("{}/", tools.uri()));
        let first = sync.apply(desired(&s)).await;
        let second = sync.apply(desired(&s)).await;
        let held = lock(&sync.written_schemas).clone();
        let third = sync.apply(desired(&sources(vec![("cars", cars())]))).await;
        let _ = std::fs::remove_file(&file);

        for outcomes in [&first, &second, &third] {
            assert!(
                matches!(&outcomes[..], [(owner, ViewOutcome::Written)] if owner.name == "air"),
                "{outcomes:?}"
            );
        }
        assert_eq!(held, BTreeSet::from(["city-air".to_owned()]));
        assert!(lock(&sync.written_schemas).is_empty());
    }

    /// What keeps a schema out of the broker is the space's condition: a model that does not
    /// compile (nothing sent), a broker with no schema bound (its 503 and detail), no Model
    /// Tools configured.
    #[tokio::test]
    async fn a_schema_that_is_not_written_says_why_on_the_space() {
        let s = with_model(sources(vec![("cars", cars())]));
        let file = token_file();

        let broken = model_tools(
            json!({"errors": ["slot 'pm10': range 'Foo' is unknown"]}),
            1,
        )
        .await;
        let server = broker_with_the_space_view(&s).await;
        Mock::given(method("PUT"))
            .and(path("/q/schemas/city-air"))
            .respond_with(ResponseTemplate::new(201))
            .expect(0)
            .mount(&server)
            .await;
        let refused = ViewSync::new(server.uri(), &file)
            .with_model_tools(broken.uri())
            .apply(desired(&s))
            .await;

        let tools = model_tools(
            json!({"brokerSchema": {"id": "https://city.example/air", "name": "air"}}),
            1,
        )
        .await;
        let unbound = broker_with_the_space_view(&s).await;
        json_at("/q/schemas/city-air", 404, json!({}))
            .mount(&unbound)
            .await;
        Mock::given(method("PUT"))
            .and(path("/q/schemas/city-air"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "type": "https://uri.etsi.org/ngsi-ld/errors/OperationNotSupported",
                "detail": "ANTARES_SCHEMA_MAX_BYTES is unset"
            })))
            .expect(1)
            .mount(&unbound)
            .await;
        let failed = ViewSync::new(unbound.uri(), &file)
            .with_model_tools(tools.uri())
            .apply(desired(&s))
            .await;

        let unconfigured = ViewSync::new(broker_with_the_space_view(&s).await.uri(), &file)
            .apply(desired(&s))
            .await;
        let _ = std::fs::remove_file(&file);

        assert!(
            matches!(&refused[..], [(_, ViewOutcome::Refused(r))]
                if r.contains("air-quality does not compile") && r.contains("range 'Foo'")),
            "{refused:?}"
        );
        assert!(
            matches!(&failed[..], [(_, ViewOutcome::Failed(r))]
                if r.contains("PUT /q/schemas/city-air") && r.contains("503") && r.contains("ANTARES_SCHEMA_MAX_BYTES")),
            "{failed:?}"
        );
        assert!(
            matches!(&unconfigured[..], [(_, ViewOutcome::Failed(r))] if r.contains("JC_PORTAL_MODEL_TOOLS_URL")),
            "{unconfigured:?}"
        );
    }

    /// The broker this test writes to: the `-jc` image ci-full starts (views, linkml,
    /// `ANTARES_POLICY=joinedcontext`, `ANTARES_SCHEMA_MAX_BYTES`) and the file holding its
    /// admin token. ci-full's `test-all`, the job that starts it, without them is a failure,
    /// never a pass; elsewhere the test returns, other ci-full jobs (the README's commands) too.
    fn jc_broker() -> Option<(String, PathBuf)> {
        let url = std::env::var("JC_PORTAL_TEST_BROKER_URL").ok();
        let token = std::env::var("JC_PORTAL_TEST_BROKER_TOKEN_FILE").ok();
        match (url, token) {
            (Some(url), Some(token)) if !url.trim().is_empty() && !token.trim().is_empty() => {
                Some((
                    url.trim().trim_end_matches('/').to_owned(),
                    PathBuf::from(token),
                ))
            }
            _ => {
                assert!(
                    !(std::env::var("GITHUB_WORKFLOW").as_deref() == Ok("ci-full")
                        && std::env::var("GITHUB_JOB").as_deref() == Ok("test-all")),
                    "ci-full test-all starts the -jc broker and must set \
                     JC_PORTAL_TEST_BROKER_URL and JC_PORTAL_TEST_BROKER_TOKEN_FILE"
                );
                eprintln!(
                    "JC_PORTAL_TEST_BROKER_URL is not set: the -jc broker test runs in ci-full"
                );
                None
            }
        }
    }

    /// The writer against the real `-jc` broker: create, change and delete; a view written by
    /// hand is left alone; a refused Endpoint is reported and never sent; the rule document
    /// and the schema are what the broker then holds. The schema is what Model Tools' `gen_broker_schema.py`
    /// renders from the platform's `senzor.linkml.yaml` fixture.
    #[tokio::test]
    async fn the_writer_converges_the_jc_broker() {
        let Some((broker, token_file)) = jc_broker() else {
            return;
        };
        let token = std::fs::read_to_string(&token_file).expect("the token file reads");
        let token = token.trim();
        let http = reqwest::Client::new();
        let get = |path: &str| {
            let request = http.get(format!("{broker}{path}")).bearer_auth(token);
            async move {
                let response = request.send().await.expect("the broker answers");
                let status = response.status().as_u16();
                (
                    status,
                    response.json::<Value>().await.unwrap_or(Value::Null),
                )
            }
        };
        let hand_made = json!({"id": "my-view", "tenant": "city-air", "selector": ["Car"],
                               "rules": [{"types": ["Car"], "attributes": []}],
                               "operations": ["retrieve_entity"]});
        let put = http
            .put(format!("{broker}/q/views/my-view"))
            .bearer_auth(token)
            .json(&hand_made)
            .send()
            .await
            .expect("the broker answers");
        assert!(
            put.status().is_success(),
            "the hand-made view: {}",
            put.status()
        );

        let schema: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/broker-schema-senzor.json"
        ))
        .expect("the fixture is JSON");
        let tools = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/generate"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"brokerSchema": schema, "errors": []})),
            )
            .mount(&tools)
            .await;
        let sync = ViewSync::new(broker.clone(), &token_file).with_model_tools(tools.uri());
        let mut s = with_model(sources(vec![("cars", cars())]));
        s.endpoints.push(endpoint(json!({})));
        s.endpoints.push(endpoint_named(
            "mapped",
            json!({"slug": "m3mqavzt5xkc2nhw7brj4gd6sy",
                   "viewMappingRef": {"kind": "Mapping", "name": "m"}}),
        ));

        // Create.
        let made = desired(&s);
        let outcomes: BTreeMap<String, ViewOutcome> = sync
            .apply(desired(&s))
            .await
            .into_iter()
            .map(|(owner, outcome)| (owner.name, outcome))
            .collect();
        assert_eq!(outcomes["air-public"], ViewOutcome::Written, "{outcomes:?}");
        assert_eq!(outcomes["air"], ViewOutcome::Written, "{outcomes:?}");
        assert!(
            matches!(&outcomes["mapped"], ViewOutcome::Refused(r) if r.contains("viewMappingRef"))
        );
        let (_, listed) = get("/q/views").await;
        for id in [SLUG, "cs-city-air", "my-view"] {
            assert!(listed.get(id).is_some(), "{id} is not listed: {listed}");
        }
        assert!(
            listed.get("m3mqavzt5xkc2nhw7brj4gd6sy").is_none(),
            "{listed}"
        );
        assert_eq!(
            get(&format!("/q/views/{SLUG}")).await,
            (200, made.views[SLUG].1.clone())
        );
        let (_, document) = get("/q/policy/city-air").await;
        assert_eq!(document["document"], made.documents["city-air"].1);
        assert_eq!(get("/q/schemas/city-air").await, (200, schema.clone()));
        let (_, health) = get("/q/health").await;
        assert!(
            health["schemas"]["city-air"]["bytes"]
                .as_u64()
                .is_some_and(|b| b > 0),
            "{health}"
        );

        // Change: a second Policy widens the Endpoint's view and the rule document.
        let mut changed = with_model(sources(vec![
            ("cars", cars()),
            (
                "bikes",
                policy(json!({"information": [{"entities": [{"type": "Bike"}]}]})),
            ),
        ]));
        changed.endpoints.push(endpoint(json!({})));
        let wanted = desired(&changed);
        assert_ne!(wanted.views[SLUG].1, made.views[SLUG].1);
        let outcomes = sync.apply(desired(&changed)).await;
        assert!(
            outcomes.iter().all(|(_, o)| *o == ViewOutcome::Written),
            "{outcomes:?}"
        );
        assert_eq!(
            get(&format!("/q/views/{SLUG}")).await,
            (200, wanted.views[SLUG].1.clone())
        );
        let (_, document) = get("/q/policy/city-air").await;
        assert_eq!(document["document"], wanted.documents["city-air"].1);

        // Delete: nothing declared, so every owned view, the document and the schema go.
        let outcomes = sync.apply(Desired::default()).await;
        assert!(outcomes.is_empty(), "{outcomes:?}");
        let (_, listed) = get("/q/views").await;
        assert!(
            listed.get(SLUG).is_none() && listed.get("cs-city-air").is_none(),
            "{listed}"
        );
        assert!(
            listed.get("my-view").is_some(),
            "the hand-made view was removed: {listed}"
        );
        assert_eq!(get("/q/policy/city-air").await.0, 404);
        assert_eq!(get("/q/schemas/city-air").await.0, 404);
    }
}
