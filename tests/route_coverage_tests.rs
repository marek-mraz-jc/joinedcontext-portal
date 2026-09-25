//! Every route the Portal serves is an operation of the registry or says why it is not (AG-59,
//! CC-48, T-0840). Moved out of `src/ops/mod.rs` (T-1499): the table is data about the whole
//! crate, and the registry's module keeps the registry.

use joinedcontext_portal::ops;

/// Every route the Portal serves, and the operation behind it (AG-59, CC-48, T-0840).
///
/// The third column is the operation's name, or the sentence saying why the route has none.
/// A route with neither fails the test below, so a new door is a decision rather than
/// something only a browser ever knew about.
const ROUTE_COVERAGE: &[(&str, &str, &str)] = &[
("GET", "/.well-known/oauth-protected-resource", "the OAuth resource metadata an MCP client reads before it authenticates"),
("GET", "/.well-known/oauth-protected-resource/api/v1/mcp", "the OAuth resource metadata an MCP client reads before it authenticates"),
("POST", "/activity", "the runner's OTLP ingest: a workload writes what happened, nobody calls it"),
("GET", "/apps/{name}/", "a published application, served as files"),
("GET", "/apps/{name}/{*path}", "a published application, served as files"),
("POST", "/apps/{name}/api/functions/{fn}", "a published application's own function, called by its page with the person's edge token (AP-84, SDK-23); what it does is the application's, not an operation of the platform"),
("POST", "/auth/backchannel-logout", "signing out"),
("GET", "/auth/callback", "signing in"),
("GET", "/auth/login", "signing in"),
("POST", "/auth/logout", "signing out"),
("GET", "/auth/me", "who is signed in"),
("GET", "/blueprints", "the organisation's gallery, not a project's data; jc_flow_start runs one by name"),
("GET", "/branding", "the instance's look, not a project's data"),
("GET", "/branding/{asset}", "the instance's look, not a project's data"),
("GET", "/catalogue", "the public open-data catalogue, read from CKAN as an anonymous caller (EP-81): not a project's data"),
("GET", "/catalogue/datasets/{name}", "the public open-data catalogue, read from CKAN as an anonymous caller (EP-82): not a project's data"),
("GET", "/catalogue/datasets/{name}/sample", "a public Endpoint read anonymously, as any visitor of the catalogue reads it (EP-82)"),
("GET", "/forms", "the form definitions the Portal renders, not a project's data"),
("GET", "/health", "liveness"),
("POST", "/internal/agent-runs/events", "the runner's own callback, authenticated as a workload"),
("GET", "/internal/agent-runs/{id}", "the runner's own callback, authenticated as a workload"),
("GET", "/internal/agent-runs/{id}/diagnostics/{component}/{name}", "the runner's own callback, authenticated as a workload"),
("POST", "/internal/pipelines/{project}/{name}/outcomes", "the pipeline runner's outcome sink posts the records of a batch the gateway took, authenticated as a workload (PL-62)"),
("POST", "/internal/pipelines/{project}/{name}/rejected", "the pipeline runner's validation stage posts a refused record, authenticated as a workload (PL-61)"),
("GET", "/internal/agent-runs/{id}/inbox", "the runner's own callback, authenticated as a workload"),
("POST", "/internal/agent-runs/{id}/mcp", "the whole registry for one run, narrowed by its AgentProfile (AG-70) and refused an approval (AG-11)"),
("POST", "/internal/pipeline-tests/{id}", "the runner's own callback, authenticated as a workload"),
("GET", "/internal/domain-verifications", "the gateway's read of each Organization's domain state, authenticated as a workload"),
("GET", "/internal/previews", "the gateway's read of the running previews, authenticated as a workload"),
("GET", "/mcp", "the MCP door itself, which dispatches this registry"),
("POST", "/mcp", "the MCP door itself, which dispatches this registry"),
("GET", "/metrics", "the Prometheus scrape"),
("GET", "/openapi.json", "the API document"),
("GET", "/organization/health", "the validation checks' published results, about the installation and not a project's data (OPS-53)"),
("GET", "/organization/setup", "a summary for the setup page, read from manifests the operations registry already reaches and from the deployment; it writes nothing (T-2748, API/01 §25)"),
("GET", "/organization/people", "jc_person_list"),
("POST", "/organization/people", "jc_person_create"),
("GET", "/organization/people/{id}", "jc_person_get"),
("PATCH", "/organization/people/{id}", "jc_person_edit"),
("DELETE", "/organization/people/{id}", "deleting a person is a Change that takes them out of every Group and RoleBinding, proposed by a person on the page (PF-94)"),
("POST", "/organization/people/{id}/disable", "jc_person_disable"),
("POST", "/organization/people/{id}/enable", "jc_person_enable"),
("POST", "/organization/people/{id}/remove-second-factor", "removing a second factor takes away a way in; a person does it at the Portal, never a tool (PF-93, AG-11)"),
("POST", "/organization/people/{id}/reset-password", "a reset answers a temporary password, which never reaches a tool's answer (PF-92, AG-11)"),
("POST", "/organization/people/{id}/sign-out", "jc_person_sign_out"),
("GET", "/preferences", "this person's own Portal preferences, not a project's data"),
("PUT", "/preferences", "this person's own Portal preferences, not a project's data"),
("GET", "/endpoints", "jc_endpoint_list_all"),
("GET", "/projects", "the door before a project; every operation runs inside one"),
("POST", "/projects", "jc_project_create"),
("GET", "/projects/{project}", "jc_project_get"),
("DELETE", "/projects/{project}", "jc_project_delete"),
("POST", "/projects/{project}/duplicate", "copies a whole repository of the forge under a new slug (PF-89): a person's decision in the Portal, not a tool a run holds"),
("GET", "/projects/{project}/app-checks", "the App probe's published verdicts, about the installation's checks and not a manifest (AP-136)"),
("GET", "/projects/{project}/activity", "jc_activity_list"),
("POST", "/projects/{project}/catalogue/drafts", "drafts the publish form and writes nothing; the proposal is the Endpoint's own, jc_endpoint_propose"),
("GET", "/projects/{project}/activity/stream", "a live stream, not a call and an answer"),
// Drift is read and resolved on the page, not through the assistant (CC-21, UI-26): a
// resolution is a write to the live space or to the repository, and a model proposing one
// would be acting on a comparison it cannot see. Both are held to `propose` on `Entity`.
("GET", "/projects/{project}/drift", "read on the page; a scan result is not an operation"),
("POST", "/projects/{project}/drift/{space}/{id}/revert", "a resolution a person picks, held to propose on Entity"),
("POST", "/projects/{project}/drift/{space}/{id}/adopt", "a resolution a person picks, held to propose on Entity"),
("GET", "/projects/{project}/agent-runs", "jc_run_list"),
("POST", "/projects/{project}/agent-runs", "jc_run_create"),
("GET", "/projects/{project}/agent-runs/{id}", "jc_run_get"),
("POST", "/projects/{project}/agent-runs/{id}/answers", "jc_run_answer"),
("POST", "/projects/{project}/agent-runs/{id}/cancel", "jc_run_cancel"),
("GET", "/projects/{project}/agent-runs/{id}/events", "a live stream, not a call and an answer"),
("POST", "/projects/{project}/agent-runs/{id}/functions/{fn}", "the run calling its own tools back through the Portal"),
("POST", "/projects/{project}/agent-runs/{id}/messages", "jc_run_message"),
("GET", "/projects/{project}/agent-runs/{id}/preview", "the page that frames a run's preview, not an answer"),
("POST", "/projects/{project}/agent-runs/{id}/preview-errors", "the preview frame reporting its own errors"),
("POST", "/projects/{project}/agent-runs/{id}/preview-observations", "the preview frame reporting what it sees"),
("POST", "/projects/{project}/agent-runs/{id}/publish", "jc_run_publish"),
("GET", "/projects/{project}/apps/{name}/build", "links of the App page to the forge's own repository, run and package pages (AP-103); what they show is read in the forge"),
("GET", "/projects/{project}/apps/{name}/me", "a fullstack App's backend asks for the caller's roles with the edge token (AP-109); an agent acts as itself, never as a person in an App"),
("POST", "/projects/{project}/apps/{name}/rebuild", "a person asks the forge to run the App's reviewed build.yml again (AP-103); an agent changes an application by a run, which the workflow builds on merge"),
("GET", "/projects/{project}/assistant/access", "what the assistant may reach here; the registry's own listing answers the same question"),
("GET", "/projects/{project}/assistant/catalog", "jc_catalog_search"),
("POST", "/projects/{project}/assistant/conversations", "the assistant's own door; jc_run_create starts a conversation"),
("POST", "/projects/{project}/assistant/propose-endpoint", "jc_endpoint_propose"),
("GET", "/projects/{project}/basemap/{style}/style.json", "map tiles the browser fetches"),
("GET", "/projects/{project}/basemap/{style}/{z}/{x}/{tile}", "map tiles the browser fetches"),
("GET", "/projects/{project}/changes", "jc_change_list"),
("GET", "/projects/{project}/changes/{id}", "jc_change_get"),
("POST", "/projects/{project}/changes/{id}/approve", "jc_change_approve"),
("POST", "/projects/{project}/changes/{id}/reject", "jc_change_reject"),
("GET", "/projects/{project}/ckan/status", "jc_ckan_status"),
("GET", "/organization/datamodels", "the list behind the model and type pickers (DM-63); an agent reads a project's models through jc_resource_list and the catalogue through jc_catalog_search"),
("GET", "/projects/{project}/datamodels/{name}/source", "jc_model_source_get"),
("PUT", "/projects/{project}/datamodels/{name}/source", "jc_model_source_put"),
("GET", "/projects/{project}/drafts", "jc_draft_list"),
("GET", "/projects/{project}/drafts/events", "a live stream, not a call and an answer"),
("GET", "/projects/{project}/drafts/{kind}/{name}", "jc_draft_get"),
("PUT", "/projects/{project}/drafts/{kind}/{name}", "jc_draft_put"),
("DELETE", "/projects/{project}/drafts/{kind}/{name}", "jc_draft_drop"),
("GET", "/projects/{project}/export", "jc_project_export"),
("GET", "/projects/{project}/federation-graph", "jc_federation_graph"),
("POST", "/projects/{project}/flows", "jc_flow_start"),
("POST", "/projects/{project}/import", "jc_project_import"),
("GET", "/projects/{project}/ops", "the registry's own listing"),
("POST", "/projects/{project}/ops/{name}", "the registry's own door"),
("GET", "/projects/{project}/permissions/me", "what this caller may do; the listing answers it per operation"),
("POST", "/projects/{project}/pipelines/test", "jc_pipeline_test"),
("GET", "/projects/{project}/pipelines/{name}/metrics", "jc_pipeline_metrics"),
("GET", "/projects/{project}/pipelines/{name}/rejected", "the pipeline page's rejected list (PL-61, ADR-N-034); an agent asks why a record fails with jc_pipeline_validate on the record itself"),
("POST", "/projects/{project}/pipelines/{name}/rejected/retry", "a person replays the records they picked on the pipeline page once the fix merged (PL-61); an agent changes the mapping with jc_pipeline_propose and lets the next run bring them"),
("GET", "/projects/{project}/pipelines/{name}/runs", "the pipeline page's runs (PL-62); an agent reads how a pipeline is doing with jc_pipeline_metrics"),
("GET", "/projects/{project}/pipelines/{name}/runs/{run}/log", "the pipeline page's log of one run (PL-62); an agent reads why one record fails with jc_pipeline_validate on the record itself"),
("GET", "/projects/{project}/revisions", "jc_project_revisions"),
("GET", "/projects/{project}/spaces/{space}/quality", "the daily data-quality report, a reading about the data and not a manifest (DM-70)"),
("GET", "/projects/{project}/serviceaccounts/{name}/keys", "jc_service_account_key_list"),
("POST", "/projects/{project}/serviceaccounts/{name}/keys", "jc_service_account_key_mint"),
("DELETE", "/projects/{project}/serviceaccounts/{name}/keys/{keyId}", "jc_service_account_key_revoke"),
("POST", "/projects/{project}/serviceaccounts/{name}/keys/{keyId}/rotate", "jc_service_account_key_rotate"),
("GET", "/projects/{project}/serviceaccounts/{name}/keys/claims/{claimId}", "a key an MCP client asked for, read by the person who asked before it is minted (PF-104)"),
("POST", "/projects/{project}/serviceaccounts/{name}/keys/claims/{claimId}", "a key an MCP client asked for, minted by the person who asked in the Portal: an operation would hand the token back to a model (PF-104)"),
("POST", "/projects/{project}/syncsources/{name}/detach", "jc_syncsource_detach"),
("POST", "/projects/{project}/syncsources/{name}/pause", "jc_syncsource_pause"),
("GET", "/projects/{project}/syncsources/{name}/status", "jc_syncsource_status"),
("POST", "/projects/{project}/syncsources/{name}/sync", "jc_syncsource_sync"),
("GET", "/projects/{project}/workspaces", "jc_workspace_list"),
("POST", "/projects/{project}/workspaces", "jc_workspace_open"),
("GET", "/projects/{project}/workspaces/{name}", "jc_workspace_get"),
("DELETE", "/projects/{project}/workspaces/{name}", "jc_workspace_discard"),
("GET", "/projects/{project}/workspaces/{name}/compare", "jc_workspace_compare"),
("POST", "/projects/{project}/workspaces/{name}/update", "jc_workspace_update_from_main"),
("POST", "/projects/{project}/workspaces/{name}/propose", "jc_workspace_propose"),
("POST", "/projects/{project}/workspaces/{name}/preview", "jc_workspace_preview_start"),
("GET", "/projects/{project}/workspaces/{name}/preview", "jc_workspace_preview_get"),
("DELETE", "/projects/{project}/workspaces/{name}/preview", "jc_workspace_preview_stop"),
("GET", "/projects/{project}/{plural}", "jc_resource_list"),
("POST", "/projects/{project}/{plural}", "jc_resource_propose"),
("GET", "/projects/{project}/{plural}/{name}", "jc_resource_get"),
("PUT", "/projects/{project}/{plural}/{name}", "jc_resource_propose"),
("PATCH", "/projects/{project}/{plural}/{name}", "jc_resource_propose"),
("DELETE", "/projects/{project}/{plural}/{name}", "jc_resource_delete"),
("GET", "/ready", "readiness"),
("GET", "/sync", "the mirror's own sync state: the instance, not a project"),
("POST", "/tools/generate", "the model tools the Portal proxies; jc_model_propose is the project's door"),
("POST", "/tools/import-sdm", "the model tools the Portal proxies; jc_model_propose is the project's door"),
("POST", "/tools/infer-schema", "the model tools the Portal proxies; jc_model_infer is the project's door"),
("GET", "/tools/sdm-catalog", "the model tools the Portal proxies; jc_catalog_search is the project's door"),
("POST", "/webhooks/gitea", "the forge calling in"),
("POST", "/webhooks/sync/{project}/{name}", "a foreign catalogue calling in"),
];

/// Every `.route("…", …)` under `src/`, as `(METHOD, path)` with the `/api/v1` prefix off.
///
/// ponytail: the source is the inventory because `axum`'s `Router` cannot be asked what it
/// holds. A router built inside a `#[cfg(test)]` module is a fixture, so the scan stops there.
fn routes_in_source() -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read the crate's sources") {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read a source file");
            let text = text.split("\n#[cfg(test)]").next().unwrap_or_default();
            found.extend(routes_in(text));
        }
    }
    found.sort();
    found.dedup();
    found
}

fn routes_in(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(".route(") {
        let open = from + at + ".route(".len() - 1;
        let mut depth = 0usize;
        let mut end = open;
        for (offset, ch) in text[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        let call = &text[open..=end];
        from = end + 1;
        let Some(path) = call.split('"').nth(1) else {
            continue;
        };
        let path = path.strip_prefix("/api/v1").unwrap_or(path);
        for method in ["get", "post", "put", "patch", "delete"] {
            if names_method(call, method) {
                found.push((method.to_uppercase(), path.to_owned()));
            }
        }
    }
    found
}

/// `get(` as a method of this route, not the tail of a handler's name.
fn names_method(call: &str, method: &str) -> bool {
    let needle = format!("{method}(");
    let mut from = 0;
    while let Some(at) = call[from..].find(&needle) {
        let start = from + at;
        let before = call[..start].chars().next_back().unwrap_or(' ');
        if !before.is_alphanumeric() && before != '_' {
            return true;
        }
        from = start + needle.len();
    }
    false
}

#[test]
fn every_route_is_an_operation_or_says_why_it_is_not() {
    let mut expected: std::collections::HashMap<(String, String), &str> = ROUTE_COVERAGE
        .iter()
        .map(|(method, path, behind)| (((*method).to_owned(), (*path).to_owned()), *behind))
        .collect();
    assert_eq!(
        expected.len(),
        ROUTE_COVERAGE.len(),
        "ROUTE_COVERAGE names the same route twice"
    );

    for (method, path) in routes_in_source() {
        let behind = expected
            .remove(&(method.clone(), path.clone()))
            .unwrap_or_else(|| {
                panic!(
                    "route `{method} {path}` is in no line of ROUTE_COVERAGE: give it an \
                     operation, or say there why it has none"
                )
            });
        if behind.starts_with("jc_") {
            assert!(
                ops::find(behind).is_some(),
                "route `{method} {path}` names operation `{behind}`, which the registry \
                 does not hold"
            );
        } else {
            assert!(
                !behind.trim().is_empty(),
                "route `{method} {path}` has no operation and no reason"
            );
        }
    }

    let mut left: Vec<&(String, String)> = expected.keys().collect();
    left.sort();
    assert!(
        left.is_empty(),
        "ROUTE_COVERAGE names routes the Portal no longer serves: {left:?}"
    );
}

/// MF-34, T-1647…T-1654: a route with an operation behind it is published in that operation's
/// words. The OpenAPI document, the MCP tool list and the assistant each describe the same
/// door, and a person reading any of them reads the same sentence: the summary is the
/// operation's title and the description is its description, so the two cannot drift apart.
#[test]
fn a_route_is_published_in_the_words_of_its_operation() {
    use utoipa::OpenApi;
    let spec = joinedcontext_portal::openapi::ApiDoc::openapi();
    let mut compared = 0;
    let mut differ = Vec::new();
    for (method, path, operation) in ROUTE_COVERAGE {
        let Some(op) = ops::find(operation) else {
            continue;
        };
        let Some(item) = spec.paths.paths.get(&format!("/api/v1{path}")) else {
            continue;
        };
        let published = match *method {
            "GET" => item.get.as_ref(),
            "POST" => item.post.as_ref(),
            "PUT" => item.put.as_ref(),
            "PATCH" => item.patch.as_ref(),
            "DELETE" => item.delete.as_ref(),
            _ => None,
        };
        let Some(published) = published else {
            continue;
        };
        compared += 1;
        let wanted = format!("{}.", op.description.trim_end_matches('.'));
        if published.summary.as_deref() != Some(op.title)
            || published.description.as_deref() != Some(wanted.as_str())
        {
            differ.push(format!("{method} {path} ({operation})"));
        }
    }
    assert!(compared > 40, "only {compared} routes were compared");
    assert!(
        differ.is_empty(),
        "published in other words than their operation's: {differ:?}"
    );
}
