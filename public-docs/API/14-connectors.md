---
sidebar_position: 15
title: "Connectors API and the Generic Tool Set"
---

# Connectors API and the Generic Tool Set

A connector is a grant one person gives one AI client over part of the platform ([ADR-N-064](../Decisions/adr-n-064-scoped-connectors.md), [Architecture/07 §11](../Architecture/07-agents-and-mcp.md#11-scoped-connectors)). This page is the contract: the Connector record, the routes that manage it, the MCP server at `/c/{id}` and every tool it serves (AG-142…AG-157). The administrator's ceiling, `kind: DelegationPolicy`, is a Git manifest described in [Development/04](../Development/04-manifest-kinds.md#delegationpolicy).

## 1. The Connector record

The Portal stores connectors in its database, one owner each, never in Git (AG-142). The resource API's `{project}` path does not apply: a connector belongs to a person and may span projects.

```json
{
  "id": "c7m2q4x5k3w5r7t2v6y4n7p3ha",
  "name": "air-pipelines-in-claude-code",
  "owner": "3f1c9a52-6b1e-4d0a-9a4e-0c8d1b7e2f10",
  "segments": ["pipeline"],
  "scope": [
    { "project": "air", "pipeline": "*", "access": "write" },
    { "project": "air", "endpoint": "air-quality-sensors-2026-public", "access": "read" }
  ],
  "writes": true,
  "expiresAt": "2026-11-27T00:00:00Z",
  "allowedClients": ["https://claude.ai/oauth/claude-code-client-metadata"],
  "clientIsBoundary": false,
  "state": "active",
  "createdAt": "2026-10-28T19:00:00Z",
  "lastUsedAt": null,
  "url": "https://portal.{domain}/c/c7m2q4x5k3w5r7t2v6y4n7p3ha",
  "limits": { "callsPerMinute": 60, "parallelCalls": 4, "resultBytes": 1048576 }
}
```

| Field | Rule |
|---|---|
| `id` | 26 random base32 characters (`a-z`, `2-7`), set by the Portal. Not a secret; useless without the owner's token. |
| `name` | DNS-1123 label, unique per owner, at most 63 characters. |
| `segments` | One or more of `data-read`, `context`, `pipeline`, `access`, `publish`, `apps`, `operate`, `admin` (Architecture/07 §11). |
| `scope[]` | Each item names a `project` and at most one of `space`, `endpoint`, `pipeline`, the item's name or `*` for every one of that kind the owner may reach in the project; `access` is `read` or `write`. A `write` item requires `writes: true`. An empty scope is refused. |
| `scope[].personalData` | `false` by default. `true` keeps the attributes the model marks `personalData` in the answers of calls this item reaches: the whole project, or the one Endpoint it names (a space or pipeline item reaches none). Allowed only when the person's DelegationPolicy sets `personalData: true`, else `403` naming `scope[i].personalData` (AG-158). |
| `writes` | `false` by default. While false the token is read-only below the tools (AG-148). |
| `expiresAt` | Required; at most the DelegationPolicy's `maxExpiry` from now, and never more than 365 days. |
| `allowedClients` | Optional list of OAuth client ids (a CIMD URL or a realm client id). Absent: any client of the realm. |
| `clientIsBoundary` | Read-only. `true` only when every allowed client is one whose redirect URIs no local program can use (claude.ai, ChatGPT); `false` for Claude Code and `mcp-local`, which the Portal labels "intended for", never "only" (AG-153). |
| `state` | Read-only: `active`, `pending` (above the ceiling, waiting for an administrator, AG-150), `expired`, `revoked`. |
| `limits` | Read-only: what the connector may spend (§3.1). |

Each segment lists the reads its jobs need besides `jc_change_plan` (T-6039):

| Segment | Lookup reads |
|---|---|
| `access` | `jc_member_list`: the people a RoleBinding of the project reaches, directly or through a Group, with the roles they hold there. Each carries the subject as the binding names it (a Keycloak user id, or an e-mail where the binding names one) and the realm's first and last name; no other e-mail. `search` matches the subject and the name. Only a project the connector's scope names, and only with `read` on RoleBinding there, else `403`. |
| `publish` | `jc_model_source_get` (the LinkML text, so a KPI or publish block names real attributes) and `jc_kpi_compute`. |
| `apps` | `Dashboard` and `Layer` besides `App`, and the five UI tools of §2.2 while the owner's Portal tab is paired; none submits. A client without a paired tab gets the plan's `portal` link instead. |

A connector above the person's DelegationPolicy ceiling is either refused with `403` naming the field or, when the policy queues requests, stored as `pending` until an administrator approves it in the Portal.

## 2. Managing connectors

Contract for T-5950 and T-5951. The routes are not in the Portal's published OpenAPI yet, so they are listed here as a table; the branch that builds them turns the table into a route block, which `verify-openapi-snippets.py` then holds to the specification.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/v1/connectors` | the caller's connectors |
| `POST` | `/api/v1/connectors` | create; `?dryRun=All` validates only |
| `GET` | `/api/v1/connectors/options` | what a connector of the caller may name: every preset, the caller's ceiling (presets, writes, longest life), per project they read the spaces, Endpoints and pipelines they read, and the realm's MCP clients; create and edit check every item again, and a named object the caller does not read answers the same `422` as one that is not there |
| `GET` | `/api/v1/connectors/{id}` | one of the caller's connectors |
| `PATCH` | `/api/v1/connectors/{id}` | edit segments, scope, writes, expiresAt, allowedClients (JSON merge patch) |
| `DELETE` | `/api/v1/connectors/{id}` | revoke: state `revoked`, the next call through it is refused |
| `GET` | `/api/v1/connectors/{id}/activity` | the audit rows of this connector (AG-147) |
| `POST` | `/api/v1/connectors/{id}/approve` | an administrator approves a `pending` connector |

Every route takes the person's Portal session or a bearer whose audience is the Portal. A connector token is refused on every one of them with `403`: a connector cannot create, widen, approve or revoke connectors (AG-151). `approve` requires the approver to hold every right the connector asks for (`within_own_rights`, PF-51) and refuses the owner approving their own request.

Another person's connector answers `404`, the same body as an id that does not exist.

### 2.1 The organization's connectors

An organization administrator (approve and delete on `RoleBinding` at organization scope, PF-03) reads and revokes every person's connectors on routes of their own, so the owner routes above keep answering `404` for anybody else's connector (T-5975):

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/v1/organization/connectors` | every connector, live ones first, at most 500: the record of §1 plus `callsPerDay`, `denialsPerDay` and `flagged` |
| `DELETE` | `/api/v1/organization/connectors/{id}` | revoke any person's connector; the activity feed names who revoked it |

`callsPerDay` and `denialsPerDay` count the audit rows of the last 24 hours, `denialsPerDay` those with a `refused` verdict. `flagged` is true at `denialsFlag` (10) refusals in that day: a client probing past its scope. The answer carries counts only, never a call's input, a token or a target beyond the audit row's own `project/kind/name`. Anybody else gets `403`, and so does a bearer token, an administrator's own agent or a service account bound to the administrator role included: both routes answer a person's Portal session alone (AG-133).

Offboarding: disabling a person (`POST /api/v1/organization/people/{id}/disable`), removing them, or proposing their removal revokes every live connector of theirs in the same request, and a `person.changed` activity row names how many. Enabling the person again revives none: they create new connectors within the rights they then hold.

### 2.2 A paired Portal tab (T-5967)

"Connect this tab" on My connectors pairs the person's open Portal tab with one of their live connectors. While it is paired, `tools/list` at `/c/{id}` adds the assistant's five UI tools (`jc_ui_navigate`, `jc_ui_open_form`, `jc_ui_highlight`, `jc_ui_show_diff`, `jc_ui_filter_table`, [Architecture/07](../Architecture/07-agents-and-mcp.md)), each with a required `project` out of the connector's scope. A call is checked as the assistant's is (the page against the Portal's table, the kind and every field against the kind's schema, read permission, the person's own plan), held to the connector's scope (a kind of its segments, an object its scope reaches), and handed to that tab only. None of the tools saves, proposes or approves; the person proposes from the form the tab opened.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/v1/connectors/{id}/tab` | pairs the caller's tab; `201` with `tab` (the stream's id), `connector`, `name`, `until` (the session's end). A newer tab replaces the one paired before |
| `DELETE` | `/api/v1/connectors/{id}/tab` | ends the pairing; `204` |
| `GET` | `/api/v1/connectors/{id}/tab/{tab}/events` | server-sent `action` events: `frame` (`navigate` or `ui`), its checked `payload`, `tool`, `project`, `from` (connector name, MCP client), `at` |

Only the person signed in in the tab pairs it: a workload's account, and a bearer token whose `azp` is an MCP client (Claude Code's `mcp-local` among them), are refused `403`. The stream answers only the session that paired it: another person, a later sign-in of the same person or another tab id is `404`. The pairing ends with that session, a disconnect, a revoke of the connector, or a Portal restart (it is held in memory). A UI tool called with no tab paired, or with the paired tab closed, answers a tool error (`409`) that tells the model to ask the person to press Connect this tab. The tool's answer names what the tab showed and nothing of the tab or the session. The connector's audit (AG-147) keeps one row per action and one per `tab/connect` and `tab/disconnect`. The browser standard for this, WebMCP (`navigator.modelContext`), is noted for later and not built.

## 3. The MCP server at `/c/{id}`

| Method | Path | What it does |
|---|---|---|
| `POST` | `/c/{id}` | Streamable HTTP, MCP protocol `2026-07-28` |
| `GET` | `/c/{id}/.well-known/oauth-protected-resource` | RFC 9728 metadata, `resource` = `https://portal.{domain}/c/{id}` |

An unauthenticated call answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://portal.{domain}/c/{id}/.well-known/oauth-protected-resource", scope="connector:{id}"`. The metadata names the organization's realm as the authorization server and lists `connector:{id}` in `scopes_supported`; the client asks for a token with that scope. A `resource=https://portal.{domain}/c/{id}` parameter (RFC 8707) is accepted and ignored: Keycloak 26.8 cannot mint an audience per connector (ADR-N-064 §3.3).

Each call is judged in this order, and the first failure answers (AG-143, AG-144):

| Check | Failure |
|---|---|
| token signature, issuer = the organization's realm, not expired | `401` |
| audience `portal-connectors`, and the token's `connector:` scopes are exactly `connector:{id}` | `401` |
| connector exists and `sub` = its owner | `404`, the body of an unknown id |
| connector `active` (not pending, expired or revoked) | `403` naming the state |
| `azp` in `allowedClients`, when set | `403` naming the client |
| the tool is in the effective rights | `403` naming the tool |
| the call's target (project, space, Endpoint, pipeline, kind) is in the effective rights | `403` naming the target |
| per-connector and per-person limits | `429` with `Retry-After` |

The effective rights are the DelegationPolicy ceiling ∩ the owner's live rights ∩ the connector's segments and scope, computed on every call; `tools/list` lists exactly the tools they reach. Every call, allowed or refused, writes one audit row: connector, person, client, tool, target, verdict, duration. The row never holds a token, a header or a tool's input values.

A tool error answers `isError: true` with the problem document as structured content, so a model can correct its input and call again (AG-146).

### 3.1 Limits

The Portal counts each call on the verified token's `sub` and the connector id of the path, never on a header. The person's budget holds over all their connectors and `/api/v1/mcp` together, so a second connector adds no calls.

| Limit | Per connector | Per person | Past it |
|---|---|---|---|
| calls a minute | 60 | 120 | `429` problem+json, `Retry-After` = seconds until the window opens, `detail` naming whose limit |
| calls answered at once | 4 | 8 | `429` problem+json, `Retry-After: 1` |
| bytes of one tool answer | 1 MiB | 4 MiB (the route) | tool error with status `413`, `detail` naming what to narrow (`limit`, `attrs`, one name) |

A DelegationPolicy may lower these (AG-150); `limits` on the record shows the values in force. Each refusal is an audit row (`refused: rate limit`, `refused: parallel calls`, `refused: result size`), so the My connectors page shows it. The Portal assistant's model spend is capped per person per day by the agent proxy (`JC_DAILY_TOKENS_PER_PERSON`, AG-97).

## 4. The tool contract

Every tool's input is a JSON Schema 2020-12 object with `additionalProperties: false`; every output is structured content beside a short text summary. `kind` is a kind of the platform registry (Development/04 §2) and `project` a project slug. At `/c/{id}` of a connector whose scope names one project, `project` is optional and defaults to that project, taken from the stored scope and never from the request; a call naming another project is still `403` naming the target. The `initialize` instructions name the projects the connector reaches (T-6064). Names are DNS-1123 labels.

### 4.1 Errors

Every tool answers its errors as `application/problem+json` (API/09) with these types:

| Status | `type` slug | When |
|---|---|---|
| 400 | `invalid-request` | the input breaks the tool's schema; `errors[]` names each `path` |
| 403 | `forbidden` | the tool, kind or target is outside the effective rights; `detail` names which |
| 404 | `resource-not-found` | the object does not exist or the caller may not read it (one answer for both) |
| 409 | `conflict` | `apply_change` on a plan whose base moved, or a plan already applied |
| 422 | `unprocessable` | the manifest is well-formed but fails a check; `errors[]` holds `{path, message}` per finding |
| 422 | `secret-in-argument` | an argument holds a value that reads like a credential; `errors[]` names each path, never the value |
| 429 | `too-many-requests` | a limit was reached; `Retry-After` set |

### 4.2 Reading

| Tool | Input | Output | Notes |
|---|---|---|---|
| `get_schema` | `{kind, path?}` | `{kind, required, fields, example, more}`: the fields every manifest carries, one line per field (`spec.class: one of auto\|resident\|scheduled, required`) and a minimal manifest jc-core's validation accepts; with `path`, a JSON pointer into the manifest such as `/spec/sources/0`, `{kind, path, schema}`: that field's JSON Schema with the definitions it names | Every kind of the registry; no rights needed beyond the connector's. The default answer stays under 4,000 bytes; a `path` naming no field, longer than 256 bytes or not starting with `/` is a 422 on `/path`. |
| `list` | `{kind, project?, space?, q?, limit? (1-200, default 50), cursor?}` | `{items[{kind, name, project, title, state}], nextCursor?}` | Only objects in the effective scope. `q` matches name and title. |
| `get` | `{kind, project, name}` | `{manifest, etag, status}` | `secretRef` names only, never a resolved value (AG-155). |
| `query_data` | `{project, endpoint, type?, id?, q?, attrs?, georel?, geometry?, coordinates?, orderBy?, format? (normalized, concise, keyValues), temporal? {timerel, timeAt, endTimeAt?, lastN?, aggrMethods?, aggrPeriodDuration?}, count?, limit? (0-1000, 0 only with count), cursor?}` | `{entities[], total?, nextCursor?}` | Reads one Endpoint through the gateway as the owner: the Portal exchanges the token the call came with (RFC 8693, audience `mcp-hub`, scopes `gateway-hub endpoint:{slug}`, both optional scopes of `portal-api`, the only one carrying the hub audience) and never reads with a token of its own; the gateway admits a hub-audience token on an Endpoint only from `portal-api` and only with the `endpoint:{slug}` scope naming that Endpoint ([02](02-endpoint-representations.md)), and decides the read on the person's grants; a refused exchange answers `403` when the person's session ended (sign in again) and `503` naming the realm setting an administrator must change otherwise; the query language is the Data MCP's (AG-84). A temporal read of an Endpoint whose view lists no history is `404` "serves no history". Entity text arrives inside the untrusted-data fence (AG-20). Attributes the model marks `personalData` are left out unless the scope ticks them (§4.6). Registry name `jc_data_query`. |

### 4.3 Writing: plan, then apply

| Tool | Input | Output | Notes |
|---|---|---|---|
| `plan_change` | `{project, changes[1..50]{op: create\|replace\|patch\|delete, kind, name, manifest?, patch?, source?}, workspace?}` | `{planId, baseEtag, expiresAt, diff, verdict {ok, findings[{level, path, message}]}, needsSecret[{name, key, form}]}` | The resource API's `?dryRun=All` for each change (AG-62): every check, nothing saved. A failing check answers `422` with every finding. A plan holds `secretRef` names only. |
| `apply_change` | `{planId}` | `{changeRequests[{id, url, lane, state}]}`, one per change, or with `workspace` `{workspaceChanges[{workspace, id, branch, lane}]}` | Only a plan this connector made, unchanged, within 30 minutes, with `write` on every item. Never approves: a person approves at `url` (AG-149, AG-151). |
| `revert_plan` | `{project, id, workspace?}` | as `plan_change`, plus `reverts` | The plan that undoes merged change `id`: every file it touched goes back to its version at the commit the change was cut from (`replace`, `create` for a file it deleted, `delete` for one it added). A file the default branch changed since the merge is `409` naming the file; a file outside the project or not a manifest is `422` naming it. Needs the right the original write needed on every item; applied with `apply_change` like any plan (S-53). |

A credential never passes through a connector (MF-24, T-5971). Every tool refuses an argument holding one with `secret-in-argument`, before anything reads it. A plan whose manifests name a `secretRef` the repository does not hold answers `needsSecret[{name, key, form}]`: `form` is the Portal's secret form (API/01 §59), where the person types the value. Every tool answer to a connector or an agent run is masked: a value under a credential's name, a credential-shaped string and each such word of a log line read `***`.

`plan_change` is offered whenever a segment proposes; `apply_change` only when `writes` is true. With writes off a person still sees the plan and applies it in the Portal.

In the Portal's operation registry the tools are `jc_change_plan`, `jc_change_revert_plan` and `jc_change_apply` (the `jc_<noun>_<verb>` names of every other operation). A change's `op` is `create` (the object must not exist), `replace` (it must), `patch` (an RFC 7386 merge patch onto the current manifest) or `delete`. A plan's etag covers each object's `metadata` and `spec`; a status the reconciler writes does not move it.

A DataModel change may carry `source`, the whole LinkML file its `spec.linkml` names (`patch` may then be left out). The plan runs the check `PUT .../datamodels/{name}/source?dryRun=All` runs (DM-22, DM-24): no literal secret, a range that names a class, enum or type the model, its imports or `linkml:types` define (else `422` at `/changes/N/source/classes/<Class>/attributes/<slot>/range` naming the class), and Model Tools compiles it. The diff's `model` member names the file, the `severity`, the `version` the model takes (a breaking change bumps the major), the `lane`, and each change; a breaking one carries `affectedEntities`, the stored entities of the classes it touches in the model's space as the broker counts them by type, or `notCounted` with the reason. The plan's etag also covers the published LinkML file. An apply opens one change request with the manifest, the source and the generated artifacts; `source` is not taken with `workspace`. An apply answers `404` for a plan that expired, was applied, or belongs to another person or connector, so a plan id tells nobody else anything. The Portal keeps plans in memory for their 30 minutes: after a Portal restart the client plans again.

### 4.4 Pipelines

| Tool | Input | Output | Notes |
|---|---|---|---|
| `sample_source` | `{project, dataSource \| sample {text, format}}` | `{records[≤20], fields[], count, truncated, errors[]}`; a streaming source `{streamed, seconds, …}` | The project's runner reads the declared DataSource under its egress policy; never writes Git, never stores the sample. Through a connector `sample.url` is refused: a URL a prompt carries is never fetched inside the cluster (T-6028). |
| `try_mapping` | `{project, pipeline \| draft, sample {text, format} \| messages[], steps?}` | `{input, records[], errors[{stage, step, line, message}], steps?[{step, name, reached, dropped, records[≤5], errors[≤5{line, message}], fields?, truncated?}]}` | Runs the candidate's steps in the pipeline test sandbox (PL-43); writes nothing. As `sample_source`, no `sample.url` through a connector. With `steps: true` the answer also carries what each step made of the sample (T-6082): its distinct records masked as the activity pipeline masks them (OPS-48), how many messages reached it whole (`reached`) and failed at it (`dropped`), and their errors. The per-step records of one answer hold at most 32 KiB; a step past that keeps its counts, errors and `fields` and says `truncated: true`. A message a step deletes counts in neither number. `jc_pipeline_test` takes the same `steps`. |
| `run_pipeline` | `{project, name}` | `{run, state: queued}` | Queues one run of the approved pipeline now and answers at once, never waiting for the run (PL-78). Offered only with `writes` on a connector whose segments reach Pipeline (`pipeline`, `operate`), held to a scope item with `write` on that pipeline; the caller needs propose and approve on Pipeline. The run writes through its own Endpoint and Policy, never as the connector. A run in progress or a pipeline that always runs is `409`. |
| `pipeline_logs` | `{project, name, run?, limit? (1-50, default 10), cursor?, step?}` | `{runs[{run, sent, rejected, failed, …}], run, lines[{id, at, recordId, step?, outcome, message}], next?}` | The newest runs with their counts and one run's log (the newest unless `run` names one), newest line first. A page holds at most 32 KiB of lines; `next` is the `cursor` of the following page. `step` keeps only the lines of that step of `spec.steps` (T-6082); `next` then still reads on past the lines it skipped. Masked as the activity pipeline masks them (OPS-48). |

In the Portal's operation registry they are `jc_pipeline_sample_source`, `jc_pipeline_try_mapping`, `jc_pipeline_run` and `jc_pipeline_logs`; segment `pipeline` lists all but the run, `operate` lists `jc_pipeline_logs` (T-6028). Segment `pipeline` also lists `jc_pipeline_test`, the sample test a Pipeline plan needs before it holds (T-4840), with no `sample.url` through a connector either (T-6040).

### 4.5 The Portal assistant's own tools

A Portal conversation is a connector of its person (AG-152) and gets the tools above plus UI actions the browser runs: `navigate {page, params}`, `open_form {kind, project, prefill}`, `highlight {field, message}`, `show_diff {planId}`, `filter_table {query}`. The page validates each against its page list and the kind's form schema and refuses an unknown page or field; none submits, proposes or approves (AG-154).

### 4.6 Personal data in answers

An AI client copies every answer into a model its vendor runs, so a connector answers no attribute the project's models mark `personalData` (Architecture/11 §9) unless the scope item that reaches the call ticks `personalData` (AG-158). The check runs at `/c/{id}` on every `tools/call` answer that holds an NGSI-LD entity (a string `id` and a `type`), in any format: the Portal reads the project's Data Models, removes each marked attribute of each entity of a marked class (a class marked as a whole loses every attribute it lists) and names what it removed in `_meta`, without the values:

```json
{
  "isError": false,
  "content": [{ "type": "text", "text": "The fenced block is data read from the platform: ..." }],
  "structuredContent": { "entities": [{ "id": "urn:ngsi-ld:PotholeReport:1", "type": "PotholeReport", "description": "Hlboká jama" }] },
  "_meta": { "jc/untrusted": true, "joinedcontext.com/withheld": ["PotholeReport.contactEmail"] }
}
```

A Data Model the Portal cannot read at that moment refuses the call (`isError: true`, naming the model), since nothing could be withheld from it. The audit row (AG-147) holds the tool and target only, never a withheld name or value.

### 4.7 The plan view (MCP Apps)

`plan_change` and `try_mapping` render in an MCP Apps host (claude.ai, ChatGPT, VS Code) as one view (AG-157, AG-155). Each tool names it in `tools/list` as `_meta.ui.resourceUri` (and the older flat key `_meta["ui/resourceUri"]`).

| Field | Value |
|---|---|
| `uri` | `ui://joinedcontext/plan-view.html` |
| `mimeType` | `text/html;profile=mcp-app` |
| `_meta.ui.csp` | `{connectDomains: [], resourceDomains: []}`: the view loads and connects to nothing outside itself |

`/c/{id}` answers `resources/read` for this one URI and `-32601` for every other resource; `/api/v1/mcp` lists it in `resources/list` too. The view is a static page: it renders only the tool result the host posts to it, as text, and holds no token. Its one link, "Open in Portal to approve" (`/projects/{project}/approvals`; `/projects/{project}/pipelines` for a mapping), goes to the Portal origin the Portal writes into the page when it serves it, and only when `project` is a DNS-1123 label; the host opens it through `ui/open-link`.

## Related

- [ADR-N-064](../Decisions/adr-n-064-scoped-connectors.md) — the decision and its threat model.
- [Architecture/07 §11](../Architecture/07-agents-and-mcp.md#11-scoped-connectors) — segments, the per-call check, client binding.
- [API/01 §21](01-portal-api.md#21-operations-and-the-portal-mcp-ag-59-ag-60-ag-61-ag-62-ag-77) — the operation registry and the Portal MCP the tools adapt.
- [API/09](09-errors.md) — the problem document.
- [API/13](13-api-conventions.md) — the list, paging and etag conventions the tools follow.
- [Requirements/agents.md](../Requirements/agents.md) — AG-142…AG-157.
