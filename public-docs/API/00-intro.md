---
sidebar_position: 1
title: API Overview & Architecture
description: Comprehensive API map, authentication specifications, rate limits, and standard protocols for joinedcontext.
---

# API Overview & Architecture

joinedcontext exposes standard-first, versioned programmatic interfaces. The platform eliminates custom proprietary APIs in favor of internationally ratified specifications:

- **ETSI GS CIM 009 (NGSI-LD V1.9.1):** Core context data operations. That is the version the default broker implements and the version the conformance suite runs (1822 cases); a page citing an older one is citing a specification this platform does not serve.
- **OGC API - Features Part 1:** Geospatial feature queries.
- **OGC SensorThings API (STA) v1.1:** Time-series sensor streams.
- **Model Context Protocol:** autonomous agent tool integration. The Portal's MCP server negotiates `2026-07-28`, `2025-11-25`, `2025-06-18` or `2025-03-26` and answers with the newest the client names (`joinedcontext-portal/src/mcp/mod.rs`); an endpoint's own MCP server speaks `2025-06-18` (`joinedcontext-platform/crates/context-gateway/src/mcp/endpoint_facade.rs`).
- **OpenAPI 3.1:** Platform management and administrative operations.

---

## 1. Global API Map & Base URLs

```mermaid
flowchart LR
    CLIENT["API Client / Browser / Agent"]
    
    subgraph EDGE["Public Gateway Edge (APISIX)"]
        AUTH["OIDC Bearer Verification"]
        RATE["Rate Limiting & Routing"]
    end
    
    subgraph SURFACES["Platform API Surfaces"]
        PORTAL["1. Portal Management API<br/>/api/v1/..."]
        SPACE["2. Canonical Space Surface<br/>/cs/{space}/..."]
        ENDPOINT["3. Shared Endpoint Surface<br/>/api/endpoint/{endpointSlug}/..."]
        MCP_SRV["4. Portal MCP<br/>/api/v1/mcp"]
    end
    
    CLIENT --> EDGE
    EDGE --> AUTH --> RATE
    RATE --> PORTAL
    RATE --> SPACE
    RATE --> ENDPOINT
    RATE --> MCP_SRV
```

| API Surface | Base Path URL | Purpose | Primary Consumer |
|---|---|---|---|
| **Portal Management API** | `https://{host}/api/v1/...` | Managing projects, organizations, blueprints, and approvals | Portal UI, CI systems, admin scripts |
| **Canonical Space Surface** | `https://{host}/cs/{space}/...` | Direct NGSI-LD access for the project owning the space | Project team members, resident pipelines |
| **Shared Endpoint Surface** | `https://{host}/api/endpoint/{endpointSlug}/...`| Multi-representation data consumption (GeoJSON, CSV, OGC, MCP) | Dashboards, external users, QGIS, agents |
| **Portal MCP** | `https://{host}/api/v1/mcp` | The management API as agent tools: proposing manifests, opening changes, reading a project | AI agents (Claude Code, OpenHands) |
| **Endpoint and space MCP** | `https://{host}/api/endpoint/{endpointSlug}/mcp`, `https://{host}/cs/{space}/mcp` | The context data of one endpoint or space as agent tools, under the same Policy as every other read | AI agents |

---

## 2. Authentication & Security

All API endpoints are protected by default (fail-closed, [R5](../Requirements/access-control.md#1-architecture-and-enforcement-point)).

### Token Requirements

- **Protocol:** OpenID Connect (OIDC) / OAuth 2.1 via Keycloak ([I1](../Requirements/policy-firewall.md#21-identity-stack-i1i4-canonical-here)).
- **Header:** `Authorization: Bearer <jwt>`
- **Token Claims:** Tokens carry client identity (`sub`) and tenant membership only. **Tokens never carry permissions or roles** ([I4](../Requirements/policy-firewall.md#21-identity-stack-i1i4-canonical-here)); permissions are evaluated dynamically at the gateway using stored `Policy` entities.
- **Proof of possession:** not in the MVP. Tokens are bearer tokens, bound to the audience of the endpoint they were minted for and short-lived, which is what [AG-02](../Requirements/agents.md) requires; DPoP proofs (RFC 9449) at the edge come after the MVP (owner decision 2026-09-24).

### Anonymous Public Access

Endpoints with `audience: public` permit unauthenticated access. Requests without a bearer token are mapped automatically to the internal role `public` and evaluated against public data policies ([GW22](../Requirements/gateway-firewall.md#5-tenants-pinning-and-chaining)).

---

## 3. Rate Limiting Headers

Two limiters stand in front of a request and they do not speak the same header.

The gateway's own limiter, which an `Endpoint` configures, answers every request on the endpoint and space surfaces with the IETF draft headers (`crates/context-gateway/src/middleware/rate_limit.rs`):

```http
RateLimit-Limit: 1000
RateLimit-Remaining: 942
RateLimit-Reset: 28
```

The edge limiter is APISIX's `limit-count` with `show_limit_quota_header`, which writes `X-RateLimit-Limit` and `X-RateLimit-Remaining` instead (`joinedcontext-deployment/components/portal/apisix-plugins.yaml`). A client that wants one number reads both names.

A caller over its quota gets **HTTP 429 Too Many Requests**, an RFC 7807 problem document and a `Retry-After: <seconds>` header carrying the same seconds as `RateLimit-Reset`.

---

## 4. Standard Error Handling (RFC 7807)

Errors are returned strictly as `application/problem+json` documents:

```json
{
  "type": "https://joinedcontext.com/errors/forbidden",
  "title": "Access Denied by Policy",
  "status": 403,
  "detail": "the write touches an attribute outside the grant: operatorPhone",
  "hint": "Ask a project owner or an organization administrator for the role this needs."
}
```

`type` is always `https://joinedcontext.com/errors/{slug}` (`crates/jc-core/src/error.rs`). `detail` and `instance` are present when there is something safe to say, and never carry an upstream URL, a tenant, a broker error body or a policy name. A `400` from the Portal may carry `errors`, one entry per violation, so a form can mark every bad field in one pass.

The extension members (T-3243):

| Member | When | What |
|---|---|---|
| `hint` | every problem whose type is in the table below | what the caller does about it, one English sentence; the Portal shows its own translation by the slug |
| `field` | a validation that names one member or parameter | the member, as the request wrote it (`metadata.name`, `id`) |
| `code` | the NGSI-LD surface, where `type` is the ETSI one (CIM 009 5.5.2) | the joinedcontext slug the gateway refused with |
| `requestId` | a `500` | the reference a report is matched to a log line by |

A problem type is one of these slugs; `ProblemDetails::new` with any other fails the platform's catalogue test, and a status without a type of its own answers with the generic one for its class:

| Slug | Status | What to do |
|---|---|---|
| `bad-request` | 400 | Correct the request as the detail says and send it again. |
| `invalid-body` | 400 | Send a JSON body of the documented shape; the detail names what is wrong. |
| `urn-scheme` | 400 | Use an entity id of the form `urn:ngsi-ld:{Type}:{id}`. |
| `quality-rule` | 400 | Correct the attribute the detail names: a quality rule of the space refuses its value (DM-88). |
| `unauthorized` | 401 | Sign in again, or send a valid bearer token for this audience. |
| `forbidden` | 403 | Ask a project owner or an organization administrator for the role this needs. |
| `domain-not-verified` | 403 | Verify the domain in the organization settings first. |
| `origin-refused` | 403 | Open the WebSocket from a page on the platform's own origin, or from a client that sends no `Origin`. |
| `resource-not-found` | 404 | Check the name in the address; it does not exist or is not shared with you. |
| `method-not-allowed` | 405 | Use one of the methods the `Allow` header lists. |
| `read-only-view` | 405 | This view only reads; write through the endpoint it is built on. |
| `conflict` | 409 | Read the resource again and repeat the change on its current state. |
| `precondition-failed` | 412 | Read the entity again and send its current version in `If-Match`. |
| `payload-too-large` | 413 | Send less at once: split the request or the file. |
| `unsupported-media-type` | 415 | Send the body as `application/json` or `application/ld+json`. |
| `too-many-requests` | 429 | Wait the seconds `Retry-After` names, then try again. |
| `daily-budget` | 429 | Today's allowance is used up; try again tomorrow or ask an administrator to raise it. |
| `egress-budget-spent` | 429 | This run's outbound allowance is used up; start a new run or ask an administrator to raise it. |
| `too-many-connections` | 429, 503 | Close a WebSocket you no longer read, or wait a minute, then connect again. |
| `internal-error` | 500 | Try again; if it happens again, report the `requestId`. |
| `subscription-not-routable` | 501 | This deployment cannot deliver to that address; use an HTTP(S) receiver the platform reaches. |
| `federation-identity-unavailable` | 501 | A source of this space asks for your own token but is outside this platform; ask its steward to register it with `serviceAccount` identity. |
| `federation-exchange-failed` | 502, 503 | The identity provider did not issue your token for the brokers this read federates to; sign in again, or try again shortly. |
| `ogc-view-unavailable` | 501 | Read this endpoint through its NGSI-LD surface; its OGC surface needs a broker view it does not have. |
| `odata-view-unavailable` | 501 | Read this endpoint through its NGSI-LD surface; its OData surface needs a broker view it does not have. |
| `odata-batch-unavailable` | 501 | Send each OData write as a request of its own; `$batch` is not served through an endpoint. |
| `broker-failure` | 5xx | The context broker failed this request; try again in a minute, and report the `requestId` if it repeats. |
| `broker-unavailable` | 502 | The context broker did not open the WebSocket; try again in a minute. |
| `upstream-unavailable` | 502, 503 | A service behind the platform did not answer; try again in a minute. |
| `upstream-redirect` | 502 | The service behind the platform answered with a redirect it may not follow; ask its owner for the final address. |
| `service-unavailable` | 503 | The platform is not ready for this yet; try again in a minute. |
| `space-moving` | 503 | The space is moving to another broker and takes no writes; send the write again after the seconds `Retry-After` names. |
| `delivery-timeout` | 504 | The receiver did not answer in time; check that it is reachable and try again. |

### Existence Masking

To prevent reconnaissance, requesting an unauthorized resource via single-entity fetch returns an RFC 7807 **HTTP 404 Not Found** rather than HTTP 403, eliminating existence disclosure ([R20](../Requirements/access-control.md#5-requesting-extra-data)).

---

## 5. Well-Known Discovery Documents

The platform hosts standard well-known endpoints for automated client and agent self-configuration:

- `https://idm.{host}/realms/{realm}/.well-known/openid-configuration`: the realm's own OIDC discovery document. Keycloak serves it; the platform does not proxy it, and the APISIX routes read it from there (`components/portal/apisix-plugins.yaml`).
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/v1/mcp`: RFC 9728 metadata of the Portal MCP server (`joinedcontext-portal/src/mcp/mod.rs`).
- `/api/endpoint/{endpointSlug}/.well-known/oauth-protected-resource`: the same document for one endpoint's MCP server, which names that endpoint's audience (`crates/context-gateway/src/app.rs`).
- `/api/endpoint/{endpointSlug}/schema/index.json`: the model an endpoint serves — its classes, their slots and the generated JSON Schema. There is no platform-wide `/schema/context.jsonld`; a `@context` belongs to a space's model and is served under its endpoint.

## Related

- [R5](../Requirements/access-control.md) — referenced above.
- [I1](../Requirements/policy-firewall.md) — referenced above.
- [GW22](../Requirements/gateway-firewall.md) — referenced above.
- [AG-02](../Requirements/agents.md) — referenced above.
- [04-context-spaces-and-endpoints](../Architecture/04-context-spaces-and-endpoints.md) — the model behind the endpoints.
