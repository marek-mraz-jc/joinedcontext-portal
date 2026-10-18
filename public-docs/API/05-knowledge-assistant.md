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
- The service keeps each turn, redacted, for the deployment's `transcriptRetention` (default 30 days) so its administrators can see what an answer did (§3.1); the visitor's chat still sends `history` back with each question, and a turn of `history` is the caller's own text, so the rules in §1.4 treat it as untrusted the same as the question. (AG-99)

### 1.2 Who may ask

| Channel | Caller | Served |
|---|---|---|
| `public`, `ckan`, `iframe` | anyone; a browser's `Origin` must be one of `allowedOrigins` | by this route |
| `internal` | a signed-in person, in the Portal | through the Portal (§1.7); `404` here |

- A request whose `Origin` is present and not in the deployment's `allowedOrigins` answers `403`. The route answers CORS preflight for the allowed origins only, with `Access-Control-Allow-Origin` naming the origin, never `*`. (AG-100)
- On these channels every question carries a visitor token (§1.2.1) in `X-JC-Visitor`. A request without one, or with one that is forged, expired or another deployment's, answers `401` with a `detail` the chat shows, in Slovak; the widget then gets a new token and asks again once. (T-4653)
- A request that names no `Origin` is no browser on an allowed site: it also counts in a pool of its own, a sixth of `rateLimit.requestsPerMinute` (one at least), and all such requests share one visitor's share of the day's cost. (T-4653)
- `rateLimit.requestsPerMinute` counts every request of the deployment, `rateLimit.perClientPerMinute` the requests of one client address: `X-Forwarded-For` read from the right, past the cluster's own private, loopback and link-local proxy hops, to the address the edge appended, so an address a caller writes in front changes nothing (T-3059). Past any of them, `429` with `Retry-After` and a `detail` the chat shows, in Slovak. (AG-101)
- One client also has `rateLimit.perClientPerHour`, `rateLimit.perClientPerDay` and `rateLimit.perClientPerMonth` questions (the month is the UTC calendar month; default 300 when the manifest names none), and `rateLimit.streamsPerClient` answers in progress at once. A request that one window refuses counts in none. The service knows a client by a keyed hash of the address and the UTC day (the month, for the monthly window), with a key that is random per process; it stores and logs no address (T-4149, T-4286). Past the monthly window that client is answered as search, without a model call, under a sentence that names the day it resets (the first of the next month), like the cost cap below; the minute, hour and day windows still count, and other clients are not affected. (AG-101)
- The visitor token's id counts a minute of `rateLimit.perClientPerMinute` and `rateLimit.streamsPerClient` of its own, so people behind one address (an office, a school, a mobile carrier) each have their own minute. The hour, day and month windows and the cost share below stay the address's: a new token never buys a fresh month or cost share. With a token, the address's minute is five times `rateLimit.perClientPerMinute`. (T-4653)
- One visitor, or the no-`Origin` pool together, spends at most a tenth of `budget.costPerDayUsd` a day; past that, their questions are answered as search (as at the cost cap below) while other visitors still get answers. `history` turns on these channels are cut to 1,000 characters each. (T-4653)
- `budget.questionChars` caps the question (`400` past it) and `budget.messagesPerConversation` the questions of one conversation (`429`, start a new one). One answer takes at most 30 seconds; past that, an `error` event with status `504`. `enabled: false` answers every request `503`. (T-4149)
- `budget.costPerDayUsd` caps the day's cost: the sum of each model response's `usage.cost`, per deployment and UTC day. From the request that finds the cap reached, the chat answers as search, without a model call: one `answer` event that says so in Slovak and cites the best-matching pages, then `citations` and `done` with `modelCalls: 0`. The service logs the cap once a day. (T-4149, AG-107)
- `budget.tokensPerDay` is the model proxy's cap (§2). A question whose model call the proxy refuses for the day is answered the same way, as search with the best-matching pages, never with a refusal: no visitor reads that the assistant's answers are used up. `costPerDayUsd` is the guard a deployment is sized by; a public deployment's `tokensPerDay` is set high enough that the cost cap binds first (T-4286).
- The service answers at most 32 questions at once across its deployments; a question past that is refused, never queued: `503` with `Retry-After: 5` and nothing spent (T-3059).
- One model reply may carry at most 4 tool calls and each call's arguments at most 4,096 characters as JSON; a call past either is answered to the model with a refusal instead of being run (T-3059).

#### 1.2.1 Visitor token

A visitor token proves that the browser spent a moment of work, and gives each person behind one address a minute of their own (T-4653). It carries a random id and its expiry, nothing about the person, and the service stores nothing per token: the challenge and the token are signed with a key that is random per process, so a restart only makes the widget fetch a new one.

1. `GET https://assistant.{domain}/api/v1/d/{publicId}/challenge` answers `200`, `Cache-Control: no-store`:

   ```json
   { "challenge": "3q2-7w.1760792400.14.9f2c…", "difficulty": 14, "expiresAt": "2026-10-18T13:00:00Z" }
   ```

   `challenge` is opaque and valid for 2 minutes. `difficulty` is the number of leading zero bits the proof needs: 14, and 18 while the deployment's minute is above 80 % of `requestsPerMinute`, so a script pays more work per token when the assistant is busy.
2. The widget finds a decimal `nonce` such that SHA-256 of the UTF-8 text `{challenge}:{nonce}` starts with `difficulty` zero bits, in a Web Worker (`crypto.subtle`), while the panel opens.
3. `POST https://assistant.{domain}/api/v1/d/{publicId}/token` with `{"challenge": "…", "nonce": "48211"}` answers `200`:

   ```json
   { "token": "a41f….1760795940.0c7d…", "expiresAt": "2026-10-18T14:00:00Z" }
   ```

   valid for 1 hour. A challenge that is malformed, expired, not signed by this service for this `publicId`, or a nonce whose hash does not meet the difficulty answers `400`. The same solved challenge always gives the same visitor id, so replaying one proof is one visitor. One address redeems at most 10 tokens a minute per deployment (`429` past it); a browser needs one an hour. The challenge route keeps no state and is left to the edge's per-address limit.

Both routes follow the `Origin` rules of §1.2, and the preflight allows `GET`, `POST` and the `content-type` and `x-jc-visitor` headers. The MCP and API channels keep their own authentication and need no visitor token.

### 1.3 Answer: Server-Sent Events

`200`, `Content-Type: text/event-stream`. Events, in this order:

| Event | Data | When |
|---|---|---|
| `conversation` | `{"id": "<uuid>", "at": "2026-10-16T12:17:05Z"}`; `at` is the server's moment of the question in UTC, the one every model call of the answer is told (T-4339) | first, always |
| `stage` | `{"stage": "understanding" \| "searching" \| "reading" \| "history" \| "schema" \| "answering", "topic": "otváracie hodiny knižnice"}`; `topic` is the search query, the entity type read (`reading`, `history`) or the Endpoint whose types or schema are read (`schema`), absent otherwise | before each step of the answer; the chat shows the latest as one line until the first `delta` or the `answer` (T-4155, T-4294) |
| `tool` | `{"name": "search", "status": "started" \| "done" \| "failed"}`; a connector's tool adds `"endpoint"` | around each tool call |
| `script` | `{"code": "…", "output": "…"}`, or `"error"` in place of `"output"` | after a `run_script` call (§1.5) |
| `data` | `{"endpoint": "ovzdusie-verejne", "type": "AirQualityObserved", "columns": ["name", "pm10", "observedAt"], "units": [null, "µg/m³", null], "rows": [["Námestie SNP", 21, "2026-10-15T18:00:00Z"]], "dataset": "https://…/dataset/public-air", "download": "https://…/api/endpoint/…/ngsi-ld/v1/entities?type=…"}` | after a data round, before `delta`; at most 50 rows. The columns come by importance (T-4650): `name` (else `id`), the attributes the query named, measured values (a number with a `unitCode` or an `observedAt`), other numbers, categories, the record's metadata, and last one `observedAt`, the row's newest measurement. `units` holds, per column, the symbol (else the name) of the `unitCode` it carries, or `null`. The chat labels each column in the visitor's language with its unit, aligns numbers right and formats numbers, yes/no and times for that language. When rows carry a GeoJSON `location` and the deployment has a `viz.{domain}`, `map` holds the map spec of ADR-N-053 §2.9 built from them (the label, up to four of the values the table leads with, and `observedAt`), and the chat offers "Table \| Map", the map first when every row has a location (T-4657) |
| `visualization` | `{"spec": {…}, "rows": [{"name": "…", "pm10": 21}]}`: a Vega-Lite 5 spec over `rows`, or a map spec (ADR-N-053 §2.9) with no `rows` | after a `show_visualization` call the service accepted, at most once per answer; the chat draws it in a frame of `https://viz.{domain}/#show` (T-4657) |
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
- A data question runs a bounded loop on the server (T-4294, AG-107): the reads the router named are its first steps, then the answering model is offered the connectors' read-only tools and calls them as it needs (a filter, a count, history, a type's attributes), at most `answer.maxDataSteps` tool calls per question in all (default 10, up to 25) and within `answer.maxDataSeconds` of the question (default 20, up to 60); the whole answer may take that time plus 25 seconds, at least 30; a reply without a tool call is the answer, which arrives as one `answer` event without `delta`s. At the last call or the time limit the service asks for the answer from what was read, and the answer says what it could not read. A name not offered, arguments past 4,096 characters or against the tool's schema, and a call past the last are refused to the model and never sent; a call repeated with the same arguments is answered from the question's own results. Each `query_entities` result is also a `data` event. When the deployment has a `viz.{domain}`, the loop also offers `show_visualization`: `{"kind": "map" | "line" | "bar", "data": n, "label": "<column>", "value": "<column>", "time": "<column>", "title": "<at most 80 characters>"}`, `n` the number of a table the answer read, `label`, `value` and `time` columns of it (`value` numeric; `time` required for `line`, optional otherwise), and `map` only for a table whose rows carry a location. The service builds the spec from that table's rows and sends it as a `visualization` event; an unknown table, a column the table lacks, a map without a location or a second call in one answer is refused to the model, which answers without it. The call counts as one of the question's tool calls. (T-4657) A question the router sends to the sources alone keeps the routed answer of one streamed call.
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
page change on the host site; "Nová konverzácia" clears it. The footer under the input reads "Dôležité informácie si prosím overte. · Súkromie" ("Please verify important information. · Privacy"); "Súkromie" opens the dialog "O tomto asistentovi" inside the widget (focus held inside, Escape closes): that answers come from AI and may be wrong, no sensitive personal data belongs in a question; a switch, off by default, "Zapamätať konverzáciu v tomto prehliadači", which keeps the conversation in `localStorage` for at most 90 days after its last change and restores it on the next visit, switching off deletes that copy at once (with the warning not to switch it on on a shared device); that the service keeps conversations for the deployment's `transcriptRetention` days for running the service, review and fixing errors; and, when the deployment names `privacy.contact`, whom to write for access, correction or erasure, with `privacy.documentsUrl` when set. Nothing else is stored in the browser (T-4174, T-4670). It shows the deployment's
greeting and colour, a switch per connector, each answer formatted from a safe part of Markdown with
its markers as superscript links to its sources, listed once per address by title (AG-117), a script and
its output when there was one, and every `error` event as the sentence it carries. It is keyboard
operable and announces answers to a screen reader.

- The widget page MUST answer only for a deployment of the `public`, `ckan` or
  `iframe` channel, with `Content-Security-Policy: frame-ancestors` naming exactly the deployment's
  `allowedOrigins` and allowing scripts, styles and requests from its own host alone, and frames
  from `https://viz.{domain}` alone when the deployment has one (ADR-N-053 §2.9); it MUST set
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
| `title`, `description`, `published`, `modified` | what the page states of itself (AG-120); `null` when it does not |

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
| `languages` | its passages per language, `{"sk": 23140, "en": 2012}`; passages of no known language are not counted (UI-99) |
| `lastCrawl` | the end of the last crawl that stored anything |
| `job` | the last crawl job: `state` (`queued`, `running`, `done`, `failed`), `attempts`, `error`, `startedAt`, `finishedAt` |

`GET …/knowledge/sources/{source}/errors` answers `{"items": [{"url", "kind", "reason"}]}`: at most
50 pages (`kind: page`) and documents (`kind: document`) whose last read failed, newest first.
`reason` is `HTTP {status}` or the network error, at most 300 characters; no content of a page is
in it. A source not crawled yet answers `404`.

`GET …/knowledge/deployments/{deployment}/usage` answers `{"items": [{"day", "requests", "tokensIn",
"tokensOut", "thumbsUp", "thumbsDown", "notes"}]}` for the last 30 days; `notes` counts the thumbs
down that carry a note (§1.8).

A page carries `id`, `url`, `depth`, `parentId`, `status`, `included`, `excludedBy`, `language`,
`fetchedAt`, `children`, `documents`, `passages`, and what it states of itself: `title`,
`description`, `published` and `modified` (AG-120), each `null` where the page states none.
A document carries `id`, `url`, `pageId`, `mime`, `bytes`, `pages`, `offDomain`, `status`,
`included`, `excludedBy`, `passages`, and from its document information `title`, `description`
(its `Subject`), `published` and `modified` (AG-120). A passage carries `ordinal`, `text`, `lang`
and `url`.

`GET …/knowledge/sources/{source}/pages?q=` with a `q` of 2 to 100 characters answers, instead of
one level of the tree, at most 100 pages of the whole source whose title or address holds `q`
(case and diacritics ignored), the same fields. `GET …/knowledge/sources/{source}/search?q=&limit=`
answers the hits §4 answers for that one source, with its visibility whatever it is: the
administration sees what an internal deployment would read (UI-99, T-4659).

### 3.1 Conversations (T-4670)

Every turn of a deployment's conversations is stored at the end of the turn, a turn cut by the
answer timeout too, with what it reached (AG-99). The Portal reads them for its administrators:

```text
GET    …/knowledge/conversations?deployment=&from=&to=&status=&feedback=&slow=&minCostUsd=&q=&sort=&cursor=&limit=
GET    …/knowledge/conversations/{conversation}
DELETE …/knowledge/conversations/{conversation}
```

| Field of a list row | Meaning |
|---|---|
| `id`, `deployment`, `origin`, `startedAt`, `lastAt` | the conversation; `origin` is the site it came from, `null` without one |
| `firstQuestion`, `turns`, `routes` | the first question (redacted), the number of turns, the routes they took |
| `totalMs`, `errors`, `timeouts` | the longest turn's time and the turns that ended in an error or the timeout |
| `thumbsUp`, `thumbsDown` | the visitors' verdicts (§1.8) |
| `costUsd`, `uncosted` | the sum of the priced model calls, and how many calls the provider sent no price for; with `uncosted > 0` the sum is a floor and the Portal says the price is unknown, never $0 |

- `status` is `error`, `timeout` or `ok`; `feedback` is `up`, `down` or `none`; `slow=true` keeps
  conversations with a turn over 15 seconds; `minCostUsd` keeps those whose sum is at least that;
  `q` (2 to 100 characters) matches the questions and answers, case and diacritics ignored;
  `sort` is `lastAt` (default, newest first) or `costUsd`. `limit` is 1 to 100, default 50, and
  `nextCursor` continues.
- The detail answers `{"id", "deployment", "origin", "client", "turns": [...]}`. A turn carries
  `turn`, `at`, `question`, `answer`, `blocks` (the tables, chart and map specs it showed),
  `language`, `route`, `history` (as the client sent it), `firstTokenMs`, `totalMs`, `error`
  (`{status, title, detail}`) or `timedOut: true`, `verdict`, `costUsd`, `uncosted` and `steps`.
  A step carries `kind` (`route`, `search`, `tool`, `model`, `answer`), `name`, `endpoint`,
  `input`, `output` (at most 8 kB; `outputBytes` is the whole size), `status`, `startMs`,
  `durationMs`, `error`, and for `model` the `stage` (`router`, `judge`, `data`, `answer`),
  `model`, `provider`, `tokensIn`, `tokensOut`, `reasoningTokens` and `costUsd` (`null` when the
  provider sent none). A turn's `costUsd` is the sum of its steps', a conversation's the sum of its
  turns'.
- Every text was redacted before it was stored: an e-mail address reads `[e-mail]`, a phone
  number `[telefón]`, an IBAN `[IBAN]`, a birth number `[rodné číslo]`, a card number `[karta]`.
  Inputs and outputs are untrusted text: the Portal shows them escaped and never sends them to a
  model.
- `DELETE` removes the conversation's turns and steps (erasure, T-4668) and answers `204`; an
  unknown or another project's conversation is `404`.

## 4. Search for the MCP servers

`POST /internal/v1/search` answers the Context Gateway's `search_documents` (EP-133, AG-119,
T-4659). It is on the cluster network only: a request that carries `X-Forwarded-For` or
`Forwarded` came through a proxy and is answered `404`, and a NetworkPolicy admits the gateway
alone. It takes no token: it answers only what is public.

```json
{"query": "úradné hodiny klientskeho centra", "sources": [{"project": "banskabystrica", "source": "web"}],
 "publisher": "banskabystrica", "lang": "sk", "limit": 5}
```

- `query` 1 to 300 characters; `sources` 1 to 20; `limit` 1 to 10 (default 5); `publisher` and
  `lang` optional. Anything else in the body is `400`.
- It reads only the `visibility: public` passages of the named sources, ranks them by the chat's
  hybrid search (full text, and the local `multilingual-e5-small` embedding of the query, fused by
  reciprocal rank) and answers the best `limit`, with no model call. `publisher` keeps the
  sources of that project, the body that publishes them; `lang` keeps the passages in that
  language and those whose language is unknown.
- A source that does not exist, or is not public, is skipped as if it held nothing: the answer
  never says which sources exist.

```json
{"hits": [{"title": "Klientske centrum", "url": "https://www.banskabystrica.sk/…", "publisher": "banskabystrica",
  "description": "…", "published": null, "modified": "2026-09-30T08:12:00Z", "language": "sk",
  "text": "…", "score": 0.0325}]}
```

`text` is at most 1,200 characters. The metadata is the page's or document's (AG-120), `null`
where the source states none; a hit's `title` is the page's own, else the first heading of its
first passage.

`POST /internal/v1/sources` with `{"sources": [{"project", "source"}]}` (1 to 20) answers what the
named sources hold in public, for the tool's description, under the same rules:
`{"passages": 23140, "publishers": ["banskabystrica", "bbsk"], "languages": {"en": 0.08, "sk": 0.92}}`,
the share of each language among the passages whose language is known.

## Related

- [Architecture/22](../Architecture/22-knowledge-assistant.md): the service, its manifests and its channels.
- [ADR-N-040](../Decisions/adr-n-040-knowledge-assistant.md): the decision, §3.4 the proxy, §3.7 the threats.
- [04-agent-runs.md](04-agent-runs.md): `jc-agent-proxy` for agent runs.
- [02-endpoint-representations.md](02-endpoint-representations.md): the MCP surface of an Endpoint the connectors call.
