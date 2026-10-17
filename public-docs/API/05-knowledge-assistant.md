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
- `rateLimit.requestsPerMinute` counts every request of the deployment, `rateLimit.perClientPerMinute` the requests of one client address: `X-Forwarded-For` read from the right, past the cluster's own private, loopback and link-local proxy hops, to the address the edge appended, so an address a caller writes in front changes nothing (T-3059). Past any of them, `429` with `Retry-After` and a `detail` the chat shows, in Slovak. (AG-101)
- One client also has `rateLimit.perClientPerHour`, `rateLimit.perClientPerDay` and `rateLimit.perClientPerMonth` questions (the month is the UTC calendar month; default 300 when the manifest names none), and `rateLimit.streamsPerClient` answers in progress at once. A request that one window refuses counts in none. The service knows a client by a keyed hash of the address and the UTC day (the month, for the monthly window), with a key that is random per process; it stores and logs no address (T-4149, T-4286). Past the monthly window that client is answered as search, without a model call, under a sentence that names the day it resets (the first of the next month), like the cost cap below; the minute, hour and day windows still count, and other clients are not affected. (AG-101)
- `budget.questionChars` caps the question (`400` past it) and `budget.messagesPerConversation` the questions of one conversation (`429`, start a new one). One answer takes at most 30 seconds; past that, an `error` event with status `504`. `enabled: false` answers every request `503`. (T-4149)
- `budget.costPerDayUsd` caps the day's cost: the sum of each model response's `usage.cost`, per deployment and UTC day. From the request that finds the cap reached, the chat answers as search, without a model call: one `answer` event that says so in Slovak and cites the best-matching pages, then `citations` and `done` with `modelCalls: 0`. The service logs the cap once a day. (T-4149, AG-107)
- `budget.tokensPerDay` is the model proxy's cap (§2). A question whose model call the proxy refuses for the day is answered the same way, as search with the best-matching pages, never with a refusal: no visitor reads that the assistant's answers are used up. `costPerDayUsd` is the guard a deployment is sized by; a public deployment's `tokensPerDay` is set high enough that the cost cap binds first (T-4286).
- The service answers at most 32 questions at once across its deployments; a question past that is refused, never queued: `503` with `Retry-After: 5` and nothing spent (T-3059).
- One model reply may carry at most 4 tool calls and each call's arguments at most 4,096 characters as JSON; a call past either is answered to the model with a refusal instead of being run (T-3059).

### 1.3 Answer: Server-Sent Events

`200`, `Content-Type: text/event-stream`. Events, in this order:

| Event | Data | When |
|---|---|---|
| `conversation` | `{"id": "<uuid>", "at": "2026-10-16T12:17:05Z"}`; `at` is the server's moment of the question in UTC, the one every model call of the answer is told (T-4339) | first, always |
| `stage` | `{"stage": "understanding" \| "searching" \| "reading" \| "history" \| "schema" \| "answering", "topic": "otváracie hodiny knižnice"}`; `topic` is the search query, the entity type read (`reading`, `history`) or the Endpoint whose types or schema are read (`schema`), absent otherwise | before each step of the answer; the chat shows the latest as one line until the first `delta` or the `answer` (T-4155, T-4294) |
| `tool` | `{"name": "search", "status": "started" \| "done" \| "failed"}`; a connector's tool adds `"endpoint"` | around each tool call |
| `script` | `{"code": "…", "output": "…"}`, or `"error"` in place of `"output"` | after a `run_script` call (§1.5) |
| `data` | `{"endpoint": "ovzdusie-verejne", "type": "AirQualityObserved", "columns": ["name", "pm10", "observedAt"], "rows": [["Námestie SNP", 21, "2026-10-15T18:00:00Z"]], "dataset": "https://…/dataset/public-air", "download": "https://…/api/endpoint/…/ngsi-ld/v1/entities?type=…"}` | after a data round, before `delta`; at most 50 rows |
| `delta` | `{"text": "…"}` | zero or more, the answer's next characters as the answering model streams them |
| `answer` | `{"text": "… [1] … [2]"}` | once, the whole answer, after the last `delta` |
| `citations` | `[{"n": 1, "url": "https://…/page#page=4", "title": "Ovzdušie"}, {"n": 2, "tool": "query_entities", "endpoint": "ovzdusie-verejne", "url": "https://…/dataset/ovzdusie", "title": "Kvalita ovzdušia"}]` | after `answer` |
| `followups` | `{"questions": ["Kde je zberný dvor?", "…"]}` | after `citations`, at most once: up to 3 questions of at most 120 characters each that the router call proposed (T-4139), no extra model call; absent for a cached or search-only answer |
| `error` | `{"status": 429, "title": "Budget Spent", "detail": "…"}` | instead of `answer` |
| `done` | `{"tokens": 1834, "tokensIn": 1600, "tokensOut": 234, "modelCalls": 2, "firstTokenMs": 900, "totalMs": 3100, "cached": false, "costUsd": 0.000412, "stagesMs": {"route": 420, "search": 40, "judge": 380, "answer": 2100}, "judgeSkipped": false, "providers": {"route": "Groq", "judge": "Groq", "answer": "Google Vertex"}, "reasoningTokens": {"route": 0, "judge": 0, "answer": 64}}` | last, always; the token counts are the sums of each model response's `usage` (`prompt_tokens`, `completion_tokens`), `tokens` their total; `costUsd` is the sum of each response's `usage.cost`, present only when every call reported one, and 0 for a cached answer or one that made no call (T-4178); `stagesMs` is the wall time of each stage that ran, in milliseconds: `route` the router call, `search` and `judge` summed over the rounds, `answer` the streamed answer call from request to last token. A stage that did not run is absent. The question's own search and its judgement run beside the router call, so the stages may add up to more than `totalMs` (T-4293); `judgeSkipped` is true when the first round's passages covered the question and were not judged; `providers` names, per stage, the OpenRouter provider that served its last call, and `reasoningTokens` the reasoning tokens its calls spent (`usage.completion_tokens_details.reasoning_tokens`), each stage only when a call reported it (T-4360) |

- Every model call of the answer reads the moment of the question beside it, local first: the deployment's weekday, date, time to the minute and zone abbreviation (CET or CEST, EET or EEST, from the IANA zone on that date), then UTC. The zone is that of the deployment's first city language (`sk` Europe/Bratislava, `cs` Europe/Prague, `fi` Europe/Helsinki), UTC alone without one. "Today", "now" and "this week" resolve against it, and a question about the date or time is answered from it, like "Je piatok 16. októbra 2026, 14:17 (CEST)." The chat shows the time of each message, the question's from `at`, in the visitor's time zone, with the UTC minute beside it. (T-4339)
- Every numbered marker `[n]` in `answer` has its entry in `citations`: a passage cites its page URL (a PDF passage with `#page=N`), a tool result cites the tool and its Endpoint. (AG-102)
- `title` is the first heading of the cited page or document, when it opens with one. A tool result's citation also carries the `url` and `title` of the page the deployment's sources hold about its Endpoint (the catalogue's or its dataset's, found by the Endpoint's address), when one exists. Both come from the deployment's own sources, public ones alone on a public channel. A channel shows the title and never the tool's name. (AG-117)
- A passage citation may carry `cards`, what the cited passage itself publishes, read from its text and links without a model call: `{"kind": "contact", "name": "Klientske centrum", "phones": ["+421 48 4330 111"], "emails": ["podatelna@example.org"]}`, `{"kind": "place", "address": "Československej armády 26, 974 01 Banská Bystrica"}` or `{"kind": "procedure", "steps": ["Vyplňte žiadosť.", "…"]}`. `name` is the passage's last heading; empty lists and absent fields are left out; at most 3 cards per citation, 5 phones or e-mails per contact, 10 steps. The chat links a phone as `tel:`, an e-mail as `mailto:` and an address to an OpenStreetMap search only when each is well formed, and shows it as text otherwise. (T-4155)
- The answer is in the language of the question; the deployment's `languages` only choose the greeting and the search stemmers. (AG-103)
- An error the person can act on is an `error` event with a sentence: the conversation's budget is spent (`tokensPerConversation`), the model is unreachable, or a connector failed (the answer then goes on without it, and the `tool` event says `failed`). A spent day (`tokensPerDay`, `costPerDayUsd`) is no error: the chat answers as search (§1.2). (AG-104, T-4286)

### 1.4 The agent loop

- Crawled text, tool results and `history` are data, never instructions: they reach the model inside quoted blocks after rules that say so. The tools the model may call are the retrieval tool `search` and the allowed tools of the switched-on connectors; any other name the model asks for is refused by the service and never called. (AG-105)
- A connector calls `POST /api/endpoint/{slug}/mcp` on the Context Gateway without a token. On these channels a connector whose Endpoint is not `audience: public` is never offered, and `search` reads `visibility: public` passages of the deployment's `sources` only. (AG-106)
- A connector of another project, `{project}/{endpoint}` with `{project}` in the deployment's `scope.projects`, is offered on every channel only while that Endpoint is `audience: public`, is called without a token, and keeps that name in its `tool` and `data` events. An Endpoint of a project outside `scope.projects` is never reached. (MF-52, T-4177)
- A source of another project, `{project}/{source}` with `{project}` in the deployment's `scope.projects`, is searched in that project's own scope, with the same visibility rule as the deployment's own sources: `public` passages alone on every channel but `internal`. Each project's passages are ranked in their project and the rankings merged by fused score; a citation of another project's page carries that page's own address. A source of a project outside `scope.projects` is never read, and a project the deployment names no source of is never searched. (MF-52, T-4281)
- A data question runs a bounded loop on the server (T-4294, AG-107): the reads the router named are its first steps, then the answering model is offered the connectors' read-only tools and calls them as it needs (a filter, a count, history, a type's attributes), at most `answer.maxDataSteps` tool calls per question in all (default 10, up to 25) and within `answer.maxDataSeconds` of the question (default 20, up to 60); the whole answer may take that time plus 25 seconds, at least 30; a reply without a tool call is the answer, which arrives as one `answer` event without `delta`s. At the last call or the time limit the service asks for the answer from what was read, and the answer says what it could not read. A name not offered, arguments past 4,096 characters or against the tool's schema, and a call past the last are refused to the model and never sent; a call repeated with the same arguments is answered from the question's own results. Each `query_entities` result is also a `data` event. A question the router sends to the sources alone keeps the routed answer of one streamed call.
- `answer.routes` decides what one answer may use: `both` (default) lets the router search the sources and call the connectors; `rag` offers no connector and calls no tool, and its `data` and `tool` events never occur; `data` runs no `search` round and answers from the connectors' results alone. (MF-52, T-4281)
- With `feedback: false` the chat shows no verdict buttons and `POST /api/v1/d/{publicId}/feedback` answers `404`. (MF-52, T-4281)
- A question takes one routing call of the router model (route `rag`, `data` or both, and up to 3 search queries), at most 3 retrieval rounds the service runs itself (a follow-up round asks the router once more, with the passages' titles only), and one streamed call of the answer model. (AG-107)
- Before each model call, the conversation's tokens so far plus the call's input estimate are checked against `tokensPerConversation`; the answering call's output is capped at `outputTokensPerAnswer`. (AG-107)
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
cookie. It keeps the conversation's id and its visible turns in its own `sessionStorage` (the
browser partitions it per host site and drops it with the tab), so the open conversation survives a
page change on the host site; "Nová konverzácia" clears it. Nothing else is stored (T-4174). It shows the deployment's
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

### 1.8 Feedback on an answer

`POST https://assistant.{domain}/api/v1/d/{publicId}/feedback` takes a visitor's verdict on one
answer of a current conversation; the widget sends it from a thumbs up or down, a thumbs down
asking one optional "Čo chýbalo?" (T-4174):

```json
{"conversation": "6f1c0e9e-3b1a-4d7e-9b51-2c4f8f2a7c11", "turn": 2, "verdict": "down", "note": "Chýbali otváracie hodiny."}
```

- `turn` is the answer's place in the conversation, 1 for the first; `verdict` is `up` or `down`;
  `note`, only with `down`, is at most 500 characters. A second verdict on the same turn replaces
  the first. `204` when stored.
- The route checks `Origin` as the chat route does (§1.2) and counts against the same client's
  `rateLimit.perClientPerMinute`, in a window of its own; past it `429` with `Retry-After`. A
  conversation that is not a current one of this deployment, started from this origin, or a turn
  past the questions it asked answers `400`. A note that carries a secret's shape (a key, a token,
  a password in a URL) is refused with `400` and never stored.
- A verdict is stored with its deployment, day, turn and note alone: no address, cookie or other
  personal data. The note is data, never an instruction: no model reads it. Verdicts are deleted
  after 90 days. The usage route of §3 counts them per day.

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

Files of a `source: upload` go to `POST …/knowledge/sources/{source}/files?name={file name}` with the file itself as the request body, one file per request, at most `upload.maxBytes`; are listed by `GET …/files`; and are removed by `DELETE …/files/{id}`. The Portal fronts the same paths under `/api/v1` with `propose` on the `KnowledgeSource`. A file's type is checked by its content, never by its name or `Content-Type`: a PDF, a DOCX, an XLSX, or UTF-8 text, read as CSV or Markdown when the name ends in `.csv` or `.md`. A DOCX or XLSX whose archive unpacks past 200 MiB or 5,000 entries is refused. The name is 1 to 200 characters with no `/`, `\` or control character. Uploading a name again replaces that file. Its passages are data, never instructions (AG-105). (T-4184)

| Answer | When |
|---|---|
| `201` `{"id", "name", "mime", "bytes", "passages", "status"}` | stored and indexed; `GET …/files` lists the same fields as `items` |
| `204` | a `DELETE` removed the file and its passages |
| `400` | the name is missing or not a file name |
| `404` | no such project, source or file |
| `409` | the source is not `source: upload`, or it already holds `upload.maxFiles` files |
| `413` | the body is past `upload.maxBytes`; it is not read further |
| `415` | the content is none of the types above |

A source's row of `GET …/knowledge/sources` carries its index status, every number a count over
the service's own tables (T-4197):

| Field of a source | Meaning |
|---|---|
| `pages`, `pagesIncluded`, `documents` | what the crawls stored; a `source: upload`'s files are its documents |
| `passages`, `embedded`, `pending` | its passages, those with an embedding, and those still waiting for one |
| `failed` | pages and documents whose last read failed |
| `lastCrawl` | the end of the last crawl that stored anything |
| `job` | the last crawl job: `state` (`queued`, `running`, `done`, `failed`), `attempts`, `error`, `startedAt`, `finishedAt` |

`GET …/knowledge/sources/{source}/errors` answers `{"items": [{"url", "kind", "reason"}]}`: at most
50 pages (`kind: page`) and documents (`kind: document`) whose last read failed, newest first.
`reason` is `HTTP {status}` or the network error, at most 300 characters; no content of a page is
in it. A source not crawled yet answers `404`.

`GET …/knowledge/deployments/{deployment}/usage` answers `{"items": [{"day", "requests", "tokensIn",
"tokensOut", "thumbsUp", "thumbsDown", "notes"}]}` for the last 30 days; `notes` counts the thumbs
down that carry a note (§1.8).

A document carries `id`, `url`, `pageId`, `mime`, `bytes`, `pages`, `offDomain`, `status`,
`included`, `excludedBy` and `passages`. A passage carries `ordinal`, `text`, `lang` and `url`.

## Related

- [Architecture/22](../Architecture/22-knowledge-assistant.md): the service, its manifests and its channels.
- [ADR-N-040](../Decisions/adr-n-040-knowledge-assistant.md): the decision, §3.4 the proxy, §3.7 the threats.
- [04-agent-runs.md](04-agent-runs.md): `jc-agent-proxy` for agent runs.
- [02-endpoint-representations.md](02-endpoint-representations.md): the MCP surface of an Endpoint the connectors call.
