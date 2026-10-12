---
sidebar_position: 6
title: "Knowledge Assistant API"
description: The chat route of jc-assistant, its Server-Sent Events, and how the assistant calls jc-agent-proxy for a model.
---

# Knowledge Assistant API

`jc-assistant` ([Architecture/22](../Architecture/22-knowledge-assistant.md), [ADR-N-040](../Decisions/adr-n-040-knowledge-assistant.md)) answers one question per request on the channel an `AssistantDeployment` names. This page is the contract between a channel and the service, and between the service and `jc-agent-proxy`.

## 1. Chat

`POST https://assistant.{domain}/api/v1/d/{publicId}/chat`

`publicId` is the deployment's `spec.publicId`, unique across the organization. An unknown one, one of a channel this route does not serve, or one two deployments declare, answers `404`: no load order decides which project answers on an address (MF-52, T-3283).

### 1.1 Request

```json
{
  "conversation": "6f1c0e9e-3b1a-4d7e-9b51-2c4f8f2a7c11",
  "message": "Kde sú meracie stanice kvality ovzdušia?",
  "history": [
    { "role": "user", "text": "Aké sú dnešné podujatia?" },
    { "role": "assistant", "text": "Dnes sú dve podujatia: … [1]" }
  ],
  "connectors": ["ovzdusie-verejne"]
}
```

- `message` is 1 to 4,000 characters after trimming; `conversation`, when present, is an id this service issued; `history` holds at most 6 turns of `user` or `assistant`, each at most 4,000 characters; `connectors`, when present, is a subset of the deployment's connector Endpoints, and an empty list switches every connector off. Anything else answers `400` naming the field. The body is at most 64 KiB. (AG-98)
- The service keeps no question or answer text: `history` is what the channel holds and sends back. A turn of `history` is the caller's own text, so the rules in §1.4 treat it as untrusted the same as the question. (AG-99)

### 1.2 Who may ask

| Channel | Caller | Served |
|---|---|---|
| `public`, `ckan`, `iframe` | anyone; a browser's `Origin` must be one of `allowedOrigins` | by this route |
| `internal` | a signed-in person, in the Portal | through the Portal (§1.7); `404` here |

- A request whose `Origin` is present and not in the deployment's `allowedOrigins` answers `403`. The route answers CORS preflight for the allowed origins only, with `Access-Control-Allow-Origin` naming the origin, never `*`. (AG-100)
- `rateLimit.requestsPerMinute` counts every request of the deployment, `rateLimit.perClientPerMinute` the requests of one client address: `X-Forwarded-For` read from the right, past the cluster's own private, loopback and link-local proxy hops, to the address the edge appended, so an address a caller writes in front changes nothing (T-3059). Past either, `429` with `Retry-After`. (AG-101)
- The service answers at most 32 questions at once across its deployments; a question past that is refused, never queued: `503` with `Retry-After: 5` and nothing spent (T-3059).
- One model reply may carry at most 4 tool calls and each call's arguments at most 4,096 characters as JSON; a call past either is answered to the model with a refusal instead of being run (T-3059).

### 1.3 Answer: Server-Sent Events

`200`, `Content-Type: text/event-stream`. Events, in this order:

| Event | Data | When |
|---|---|---|
| `conversation` | `{"id": "<uuid>"}` | first, always |
| `tool` | `{"name": "search", "status": "started" \| "done" \| "failed"}`; a connector's tool adds `"endpoint"` | around each tool call |
| `script` | `{"code": "…", "output": "…"}`, or `"error"` in place of `"output"` | after a `run_script` call (§1.5) |
| `answer` | `{"text": "… [1] … [2]"}` | once, the whole answer |
| `citations` | `[{"n": 1, "url": "https://…/page#page=4", "title": "Ovzdušie"}, {"n": 2, "tool": "query_entities", "endpoint": "ovzdusie-verejne", "url": "https://…/dataset/ovzdusie", "title": "Kvalita ovzdušia"}]` | after `answer` |
| `error` | `{"status": 429, "title": "Budget Spent", "detail": "…"}` | instead of `answer` |
| `done` | `{"tokens": 1834}` | last, always |

- Every numbered marker `[n]` in `answer` has its entry in `citations`: a passage cites its page URL (a PDF passage with `#page=N`), a tool result cites the tool and its Endpoint. (AG-102)
- `title` is the first heading of the cited page or document, when it opens with one. A tool result's citation also carries the `url` and `title` of the page the deployment's sources hold about its Endpoint (the catalogue's or its dataset's, found by the Endpoint's address), when one exists. Both come from the deployment's own sources, public ones alone on a public channel. A channel shows the title and never the tool's name. (AG-117)
- The answer is in the language of the question; the deployment's `languages` only choose the greeting and the search stemmers. (AG-103)
- An error the person can act on is an `error` event with a sentence: the conversation's budget is spent (`tokensPerConversation`), the deployment's day is spent (`tokensPerDay`), the model is unreachable, or a connector failed (the answer then goes on without it, and the `tool` event says `failed`). (AG-104)

### 1.4 The agent loop

- Crawled text, tool results and `history` are data, never instructions: they reach the model inside quoted blocks after rules that say so. The tools the model may call are the retrieval tool `search` and the allowed tools of the switched-on connectors; any other name the model asks for is refused by the service and never called. (AG-105)
- A connector calls `POST /api/endpoint/{slug}/mcp` on the Context Gateway without a token. On these channels a connector whose Endpoint is not `audience: public` is never offered, and `search` reads `visibility: public` passages of the deployment's `sources` only. (AG-106)
- At most 6 model calls per question. Before each, the conversation's tokens so far plus the call's input estimate are checked against `tokensPerConversation`. The same tool with the same arguments asked twice in one question ends the loop with the answer so far. (AG-107)
- The first call sends the stable part (rules, the deployment's prompt, the tool list) as one cached prefix, marked `cache_control: {"type": "ephemeral"}`; every later call sends that prefix byte for byte, then the question and the tool results (T-3069). (AG-108)

### 1.5 Scripts over a large tool result

A tool result longer than 20,000 characters reaches the model cut. On a deployment with `sandbox: true` the model is offered `run_script` as well: `{"result": n, "code": "…"}`, JavaScript whose body receives the whole result `n` (at most 256 KiB) as `data` and returns what the model reads. `jc-assistant` runs it in `jc-functions` with no network, no file system, no clock and no environment, under its time, memory and output caps, and streams the code and its output to the person as a `script` event.

- An answer built on a script's output cites the tool result the script read (AG-102). The script itself is the model's text and runs only in the sandbox (AG-112).

### 1.6 The widget

`GET https://assistant.{domain}/d/{publicId}/widget` is the chat a site places in an iframe:

```html
<iframe src="https://assistant.{domain}/d/{publicId}/widget" title="Assistant" width="400" height="600"></iframe>
```

The page loads `/d/widget.js` and `/d/widget.css` from the same host and nothing else; it sets no
cookie and keeps the conversation and its last turns in the page alone. It shows the deployment's
greeting and colour, a switch per connector, each answer formatted from a safe part of Markdown with
its markers as superscript links to its sources, listed once per address by title (AG-117), a script and
its output when there was one, and every `error` event as the sentence it carries. It is keyboard
operable and announces answers to a screen reader.

- The widget page MUST answer only for a deployment of the `public`, `ckan` or
  `iframe` channel, with `Content-Security-Policy: frame-ancestors` naming exactly the deployment's
  `allowedOrigins` and allowing scripts, styles and requests from its own host alone; it MUST set
  no cookie. The chat route MUST accept the widget's own origin (`JC_ASSISTANT_PUBLIC_ORIGIN`)
  beside the deployment's, and every limit stays the server's (AG-100, AG-101, AG-110, AG-114).

### 1.7 In the Portal

A signed-in person asks through the Portal, `POST /api/v1/projects/{project}/knowledge/deployments/{deployment}/chat`
(API/01 §34), with the body of §1.1 and the events of §1.3. The Portal checks the person's
permission and asks `jc-assistant` on its internal path:

```http
POST {assistant}/internal/v1/projects/{project}/knowledge/deployments/{deployment}/chat
Authorization: Bearer <the Portal's service-account token>
X-JC-Person: <the person's username>
X-JC-Person-Token: <the person's access token, when the request carried one>
```

- The internal path answers the Portal's service account alone, as §3 does, and serves a
  deployment of any channel by its name. An `internal` deployment searches its sources' `public`
  and `internal` passages; a `public`, `ckan` or `iframe` one answers exactly as it answers a
  visitor (§1.4), so its administrators try what the public will get. (AG-115)
- A connector of an `internal` deployment whose Endpoint is not `audience: public` is called
  with the person's token, so the gateway decides as it decides for the person; without one it is
  not offered. A public Endpoint is called without a token on every channel. The person's token
  lives for the one question: it is never stored, logged or sent anywhere but the gateway. (AG-115)
- The deployment's `budget` caps the Portal's questions as the public ones (AG-110); an internal
  deployment without a `budget` answers an `error` event saying an administrator sets one. Its
  `rateLimit`, when it has one, counts per person. (AG-101, AG-115)

## 2. Calling the model through `jc-agent-proxy`

The assistant holds no model key. It calls `POST {proxy}/v1/llm/chat/completions` with its own token and names the deployment the call is for.

```http
POST {proxy}/v1/llm/chat/completions
Authorization: Bearer <jc-assistant service-account token, audience agent-proxy>
X-JC-Assistant-Deployment: banskabystrica/bb-public
X-JC-Assistant-Tokens-Per-Day: 2000000
```

- The proxy introspects the token: it must be active, issued to the `jc-assistant` client's service account and name the proxy's client in its audience. Anything else answers `401` with the proxy's one refusal sentence. (AG-109)
- The proxy counts every call's tokens against `{project}/{deployment}` for the UTC day and refuses the call once the day's spend has reached `X-JC-Assistant-Tokens-Per-Day` (`429`, `daily-budget`). The header carries the deployment's `budget.tokensPerDay`; a missing, zero or unparsable value is refused with `400`, so no deployment runs without a cap. (AG-110)
- Only `chat/completions` and `messages` are forwarded, with the installation's model key, as for a run. The proxy keeps no text of the call; its audit line names the deployment instead of a run. (AG-111)

## 3. Administration for the Portal

`jc-assistant` answers the Portal's administration routes (API/01 §34) on its internal paths,
`/internal/v1/projects/{project}/…` with the same shapes, on the cluster network only: the edge
routes `/api/v1/d/*` alone. Each call carries the Portal's service-account token, which the
service introspects with its own client: active, issued to the Portal's client, its audience
naming `jc-assistant`. Anything else is `401`.

| Field of a page | Meaning |
|---|---|
| `id`, `url`, `depth`, `parentId` | its place in the tree |
| `status` | `pending`, `fetched`, `failed`, `skipped` |
| `included` | whether its passages are indexed; `excludedBy` says `pattern` or `administrator` when not |
| `language`, `fetchedAt`, `children`, `documents`, `passages` | what it holds |

A document carries `id`, `url`, `pageId`, `mime`, `bytes`, `pages`, `offDomain`, `status`,
`included`, `excludedBy` and `passages`. A passage carries `ordinal`, `text`, `lang` and `url`.

## Related

- [Architecture/22](../Architecture/22-knowledge-assistant.md): the service, its manifests and its channels.
- [ADR-N-040](../Decisions/adr-n-040-knowledge-assistant.md): the decision, §3.4 the proxy, §3.7 the threats.
- [04-agent-runs.md](04-agent-runs.md): `jc-agent-proxy` for agent runs.
- [02-endpoint-representations.md](02-endpoint-representations.md): the MCP surface of an Endpoint the connectors call.
