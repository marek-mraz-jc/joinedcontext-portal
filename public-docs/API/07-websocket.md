---
sidebar_position: 8
title: Live Updates over WebSocket
description: How to receive an Endpoint's changes as they happen over one WebSocket, with the message format, the limits and examples for websocat, JavaScript and Python.
---

# Live Updates over WebSocket

Every Endpoint that serves the `websocket` standard answers a WebSocket at `{endpointUrl}/ws`. You open one connection, subscribe to the entities you care about, and each change the Endpoint's Policy lets you read arrives as a message on that connection. You need no server of your own to receive notifications, and the connection runs through the same gateway, token and Policy as every REST call (EP-106).

The broker side of this channel is Antares ADR-0026. This page describes what a client sees through an Endpoint.

## 1. Address and authentication

| | |
|---|---|
| URL | `wss://{host}/api/endpoint/{endpointSlug}/ws` |
| Public Endpoint | open without a token; you receive what the anonymous grant reads |
| Any other Endpoint | a bearer access token for the Endpoint's audience, as for REST |
| Header form | `Authorization: Bearer <token>` on the upgrade request |
| Browser form | `Sec-WebSocket-Protocol: ngsi-ld-ws, bearer.<token>`; the gateway answers `Sec-WebSocket-Protocol: ngsi-ld-ws` |

A browser cannot set an `Authorization` header on a WebSocket, so the token travels as the second subprotocol entry.

Decided (worker-7, owner may override): the subprotocol form, because it keeps the token out of the URL, where proxies, browser history and access logs would keep it; options: a token in the query string (refused), a cookie (only works for the Portal's own origin), the subprotocol (taken). The gateway removes the `bearer.` entry before it forwards the upgrade, never echoes it, and never logs it.

A token in the query string is refused with `400`. A browser page opens the socket only from an origin the installation allows; any other `Origin` answers `403` (a client without an `Origin` header, such as websocat or Python, is not affected). Without a valid token, an Endpoint that is not public answers the upgrade `401` with the same `WWW-Authenticate` header as its REST surface.

The connection's identity is fixed when it opens. It ends after 300 seconds, the lifetime of an access token. Reconnect with a fresh token and resume (§4).

## 2. Messages

Every message, in both directions, is one text frame holding one JSON object with two members, `metadata` and `body`. This is the envelope of ETSI TS 104 243 §5.2. `body` is plain NGSI-LD, and `metadata.x-op` names what the message is.

| `x-op` | Sent by | `body` |
|---|---|---|
| `x-welcome` | server, first message | none; `metadata` carries `x-connection` and `x-resume-token` |
| `x-subscribe` | you | an NGSI-LD Subscription (TS 104 175 §5.2.12) without `notification.endpoint`: the server sets it |
| `x-update` | you | the members of the Subscription to change; `metadata.x-subscription` names it |
| `x-unsubscribe` | you | none; `metadata.x-subscription` names it |
| `x-resume` | you, first message after a reconnect | none; see §4 |
| `x-result` | server | the created or updated Subscription, or a ProblemDetails; `metadata.x-status` is the HTTP status the same request would get over REST, `x-id` echoes yours |
| `x-notification` | server | the NGSI-LD Notification (TS 104 175 §5.2.6.9.1), the same body an HTTP subscriber would receive; `metadata.x-seq` counts from 1 per connection |
| `x-gap` | server | none; notifications `x-from` to `x-to` were lost, so read the entities again over REST |
| `x-closing` | server, before it closes | none; `x-reason` is `lifetime`, `overflow`, `view-removed`, `shutdown` or `idle` |

A Subscription made over the socket is an ordinary one: `GET {endpointUrl}/ngsi-ld/v1/subscriptions` lists it, and it is deleted 30 seconds after the connection closes unless you resume. A notification carries only the attributes your grant reads. A change to an attribute you cannot read sends nothing. No message tells you that an entity left what you may read, because that message would itself reveal a hidden change. Read again on `x-gap` and on your own schedule.

## 3. Limits

| Limit | Value | When exceeded |
|---|---|---|
| Connections per caller (token subject, or client address when anonymous) | 10 | the upgrade answers `429` |
| Connections per Endpoint's space | 1 000 | the upgrade answers `503` |
| Subscriptions per connection | 64 | `x-result` with `x-status: 400` |
| Message size | 64 KiB (16 KiB per frame) | the connection closes |
| Idle time (no message and no Subscription) | 60 s | `x-closing: idle` |
| Unread notifications queued | 256 | `x-gap`, then `x-closing: overflow` |
| Connection lifetime | 300 s | `x-closing: lifetime`; resume with a fresh token |

The server pings every 30 seconds and closes a connection that sent no pong for 60 seconds. Client libraries answer pings by themselves.

## 4. Resume after a reconnect

Keep `x-connection` and `x-resume-token` from `x-welcome`, and the last `x-seq` you processed. Open a new connection with a fresh token and send this first message:

```json
{"metadata": {"x-op": "x-resume", "x-id": "r1", "x-connection": "<from x-welcome>", "x-resume-token": "<from x-welcome>", "x-seq": 41}}
```

Within 30 seconds of the close, and under the same identity, you receive every notification after `x-seq` 41, then the live ones. A notification that is no longer held arrives as `x-gap` first. A resume that fails for any reason answers `x-result` with `x-status: 404`.

## 5. Examples

Subscribe to every change of `AirQualityObserved` with [websocat](https://github.com/vi/websocat):

```bash
websocat -H "Authorization: Bearer $TOKEN" "wss://{host}/api/endpoint/{endpointSlug}/ws"
{"metadata":{"x-op":"x-subscribe","x-id":"s1"},"body":{"type":"Subscription","entities":[{"type":"AirQualityObserved"}],"notification":{"attributes":["pm10","pm25"]}}}
```

The first line you type after the connection opens is the subscription. The answers arrive on standard output:

```text
{"metadata":{"x-op":"x-welcome","x-connection":"k3v…","x-resume-token":"…"}}
{"metadata":{"x-op":"x-result","x-id":"s1","x-status":201},"body":{"id":"urn:ngsi-ld:Subscription:…","type":"Subscription"}}
{"metadata":{"x-op":"x-notification","x-seq":1,"x-subscription":"urn:ngsi-ld:Subscription:…","Content-Type":"application/json"},"body":{"id":"urn:ngsi-ld:Notification:…","type":"Notification","subscriptionId":"urn:ngsi-ld:Subscription:…","notifiedAt":"2026-10-11T12:00:00Z","data":[{"id":"urn:ngsi-ld:AirQualityObserved:station-01","type":"AirQualityObserved","pm10":{"type":"Property","value":21}}]}}
```

In a browser, with the token as a subprotocol:

```js
const ws = new WebSocket(`wss://${host}/api/endpoint/${slug}/ws`, ["ngsi-ld-ws", `bearer.${token}`]);
ws.onopen = () => ws.send(JSON.stringify({
  metadata: { "x-op": "x-subscribe", "x-id": "s1" },
  body: { type: "Subscription", entities: [{ type: "AirQualityObserved" }] },
}));
ws.onmessage = (event) => {
  const { metadata, body } = JSON.parse(event.data);
  if (metadata["x-op"] === "x-notification") console.log(body.data);
  if (metadata["x-op"] === "x-gap") reload();
};
```

In Python, with the `websockets` package:

```python
import asyncio, json, os, websockets

async def main():
    url = "wss://{host}/api/endpoint/{endpointSlug}/ws"
    headers = {"Authorization": f"Bearer {os.environ['TOKEN']}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        await ws.send(json.dumps({"metadata": {"x-op": "x-subscribe", "x-id": "s1"},
                                  "body": {"type": "Subscription", "entities": [{"type": "AirQualityObserved"}]}}))
        async for frame in ws:
            message = json.loads(frame)
            if message["metadata"]["x-op"] == "x-notification":
                print(message["body"]["data"])

asyncio.run(main())
```

On a public Endpoint, leave out the header or the `bearer.` entry.

## 6. Requirements

- **EP-106** [A][S] — the WebSocket surface of an Endpoint ([Requirements/endpoints](../Requirements/endpoints.md#23-live-access-and-the-open-data-portal)).
- **EP-107** [S] — the token never in a URL; connections capped per caller.

## Related

- [API/02-endpoint-representations](02-endpoint-representations.md) — every standard an Endpoint serves, and how the open data portal lists them.
- [Requirements/endpoints](../Requirements/endpoints.md) — EP-104, EP-106 to EP-110.
- [Architecture/04-context-spaces-and-endpoints](../Architecture/04-context-spaces-and-endpoints.md) — the Endpoint model and its standards table.
- [Architecture/21-open-data-catalogue](../Architecture/21-open-data-catalogue.md) — the catalogue the Endpoint is published in.
