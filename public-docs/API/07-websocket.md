---
sidebar_position: 8
title: Live Updates over WebSocket
description: How to receive an Endpoint's changes as they happen over one WebSocket, with the message format, the limits and examples for websocat, JavaScript and Python.
---

# Live Updates over WebSocket

Every Endpoint that serves the `websocket` standard answers a WebSocket at `{endpointUrl}/ws`. You open one connection, subscribe to the entities you care about, and each change the Endpoint's Policy lets you read arrives as a message on that connection. You need no server of your own to receive notifications, and the connection runs through the same gateway, token and Policy as every REST call (EP-106).

The broker side of this channel is Antares ADR-0026. This page describes what a client sees through an Endpoint. The examples use the transport Endpoint on `dev.joinedcontext.com` (`ajaezssvx3bwqgejgepmq4ig3frgan4e`, public, entity type `Vehicle`); replace the host, the slug and the type for any other Endpoint.

## 1. Address and authentication

| | |
|---|---|
| URL | `wss://api.{domain}/api/endpoint/{endpointSlug}/ws`, on the same host as the Endpoint's REST URL (`api.dev.joinedcontext.com` on dev) |
| Subprotocol | `ngsi-ld-ws`: optional for a client that sends no token or sends it in the header, required for the browser form below |
| Public Endpoint | open without a token; you receive what the anonymous grant reads |
| Any other Endpoint | a bearer access token for the Endpoint's audience, as for REST |
| Header form | `Authorization: Bearer <token>` on the upgrade request |
| Browser form | `Sec-WebSocket-Protocol: ngsi-ld-ws, bearer.<token>`; the gateway answers `Sec-WebSocket-Protocol: ngsi-ld-ws` |

The address is the Endpoint's own URL with `/ws` appended. The Portal's host (`portal.{domain}`) is not the address of an Endpoint.

A browser cannot set an `Authorization` header on a WebSocket, so the token travels as the second subprotocol entry. The gateway removes the `bearer.` entry before it forwards the upgrade, never echoes it, and never logs it.

A token in the query string is refused with `400`. A browser page opens the socket only from an origin the installation allows; any other `Origin` answers `403` (a client without an `Origin` header, such as websocat or Python, is not affected). Without a valid token, an Endpoint that is not public answers the upgrade `401` with the same `WWW-Authenticate` header as its REST surface.

A plain `GET` of the address without an upgrade (a browser tab, `curl`) answers `426 Upgrade Required` with `Upgrade: websocket` and `Link: <https://{host}/docs/API/07-websocket>; rel="help"`: an HTML page for a browser (`Accept: text/html`) and a problem+json (`upgrade-required`) otherwise, naming the address, the subprotocol, whether a token is needed, one `x-subscribe` message for a type the Endpoint serves and a websocat line. The Endpoint's DCAT record lists the WebSocket distribution at the same address, with a one-sentence `dct:description` in the Endpoint's languages, `foaf:page` and `dct:conformsTo` both naming this page.

The connection's identity is fixed when it opens. A connection opened with a token ends after 300 seconds, the lifetime of an access token: reconnect with a fresh token and resume (§4). An anonymous connection to a public Endpoint has no token to expire and lasts up to 24 hours.

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

A Subscription made over the socket lives on that connection only. The gateway serves your sockets of an Endpoint from one broker subscription made as you, which the Endpoint's Policy decides as a read, and matches your filters itself ([ADR-N-049](../Decisions/adr-n-049-websocket-fan-out-per-endpoint.md)), so `GET {endpointUrl}/ngsi-ld/v1/subscriptions` does not list it. It ends 30 seconds after the connection closes unless you resume. Keep its id from `x-result`; it is the `x-subscription` of every `x-update` and `x-unsubscribe`.

A notification carries only the attributes your grant reads. A change to an attribute you cannot read sends nothing. No message tells you that an entity left what you may read, because that message would itself reveal a hidden change. On `x-gap`, and on your own schedule, read the subscribed types again over REST: `GET {endpointUrl}/ngsi-ld/v1/entities?type=Vehicle` for the examples below.

## 3. Limits

| Limit | Value | When exceeded |
|---|---|---|
| Connections per caller (token subject, or client address when anonymous) | 10 | the upgrade answers `429` |
| Connections per Endpoint's space | 1 000 (an installation may set fewer) | the upgrade answers `503` |
| Subscriptions per connection | 64 (an installation may set fewer) | `x-result` with `x-status: 400` |
| Message you send | 64 KiB (16 KiB per frame) | the connection closes with code `1009` |
| Message the server sends | one entity per notification, up to 1 MiB | the gateway does not read the change, and every socket of the Endpoint gets `x-gap` |
| Idle time (no message and no Subscription) | 60 s | `x-closing: idle` |
| Unread notifications queued | 256 (an installation may set fewer) | `x-gap`, then `x-closing: overflow` |
| Connection lifetime | 300 s with a token, 24 h anonymous | `x-closing: lifetime`; reconnect and resume |

The 64 KiB bound applies only to what you send. A notification carries one entity and may be up to 1 MiB.

The `ws-fanout` rig (EP-115) measures one gateway replica on a 4-vCPU GitHub runner, its clients in the same process, every notification checked against the ground truth. At 20 changes a second, the rate of dev's transit stream: 1 000 sockets p50 7 ms and p99 15 ms from change to socket; 5 000 sockets p50 25 ms and p99 237 ms, with 2.4 GiB resident. At 200 changes a second, 1 000 sockets reach p50 3.4 s and p99 6.5 s: the stream outruns one replica, and coalescing keeps each socket's latest state.

The server pings every 30 seconds and closes a connection that sent no pong for 60 seconds. Client libraries answer pings by themselves.

When the context broker refuses that subscription (your Policy reads none of the Endpoint's types, or the broker is down), the gateway serves you no notification: every open connection closes with code `1011`, and every `x-subscribe` or `x-update` answers `x-result` with `x-status: 503`, whose ProblemDetails `detail` names the broker's answer. Try again later; the gateway retries every 30 seconds ([ADR-N-049](../Decisions/adr-n-049-websocket-fan-out-per-endpoint.md) §2 item 10).

## 4. Resume after a reconnect

Keep `x-connection` and `x-resume-token` from the first `x-welcome`, and the last `x-seq` you processed. Open a new connection (with a fresh token, if you use one) and send this first message:

```json
{"metadata": {"x-op": "x-resume", "x-id": "r1", "x-connection": "<from x-welcome>", "x-resume-token": "<from x-welcome>", "x-seq": 41}}
```

Within 30 seconds of the close, under the same identity and on the same gateway replica, you get `x-result` with `x-status: 200`, then every notification after `x-seq` 41, then the live ones. The resumed connection keeps its first `x-connection` and `x-resume-token`: use those for the next resume, not the ones in the new `x-welcome`. A notification that is no longer held arrives as `x-gap` first. A resume that fails for any reason, a reconnect that reached another replica among them, answers `x-result` with `x-status: 404`: subscribe again and read the entities over REST.

## 5. Examples

Each example below runs as it stands against the public transport Endpoint and prints `Vehicle` changes. For an Endpoint that is not public, add the token as each example shows.

With [websocat](https://github.com/vi/websocat), type the subscription as the first line after the connection opens:

```bash
websocat --protocol ngsi-ld-ws wss://api.dev.joinedcontext.com/api/endpoint/ajaezssvx3bwqgejgepmq4ig3frgan4e/ws
{"metadata":{"x-op":"x-subscribe","x-id":"s1"},"body":{"type":"Subscription","entities":[{"type":"Vehicle"}],"notification":{"attributes":["speed","location"]}}}
```

With a token, add `-H "Authorization: Bearer $TOKEN"` before the address. The answers arrive on standard output:

```text
{"metadata":{"x-op":"x-welcome","x-connection":"k3v…","x-resume-token":"…"}}
{"metadata":{"x-op":"x-result","x-id":"s1","x-status":201},"body":{"id":"urn:ngsi-ld:Subscription:…","type":"Subscription"}}
{"metadata":{"x-op":"x-notification","x-seq":1,"x-subscription":"urn:ngsi-ld:Subscription:…","Content-Type":"application/json"},"body":{"id":"urn:ngsi-ld:Notification:…","type":"Notification","subscriptionId":"urn:ngsi-ld:Subscription:…","notifiedAt":"2026-10-12T23:04:39Z","data":[{"id":"urn:ngsi-ld:Vehicle:hel.fi:helsinki:12-2406","type":"Vehicle","speed":{"type":"Property","value":13.48,"unitCode":"MTS"}}]}}
```

In a browser, from a page the installation allows:

```js
const url = "wss://api.dev.joinedcontext.com/api/endpoint/ajaezssvx3bwqgejgepmq4ig3frgan4e/ws";
// With a token: new WebSocket(url, ["ngsi-ld-ws", `bearer.${token}`])
const ws = new WebSocket(url, ["ngsi-ld-ws"]);
ws.onopen = () => ws.send(JSON.stringify({
  metadata: { "x-op": "x-subscribe", "x-id": "s1" },
  body: { type: "Subscription", entities: [{ type: "Vehicle" }], notification: { attributes: ["speed", "location"] } },
}));
ws.onmessage = (event) => {
  const { metadata, body } = JSON.parse(event.data);
  if (metadata["x-op"] === "x-notification") console.log(body.data);
  if (metadata["x-op"] === "x-gap") console.log("missed changes: read /ngsi-ld/v1/entities?type=Vehicle again");
};
```

In Python, with the `websockets` package (version 14 or later), reconnecting and resuming after every close:

```python
import asyncio, json, os, websockets

URL = "wss://api.dev.joinedcontext.com/api/endpoint/ajaezssvx3bwqgejgepmq4ig3frgan4e/ws"
SUBSCRIBE = {"metadata": {"x-op": "x-subscribe", "x-id": "s1"},
             "body": {"type": "Subscription", "entities": [{"type": "Vehicle"}],
                      "notification": {"attributes": ["speed", "location"]}}}

async def main():
    resume = None  # x-connection, x-resume-token and x-seq of the connection to resume
    while True:
        # With a token: export TOKEN; a fresh one for every reconnect.
        headers = {"Authorization": f"Bearer {os.environ['TOKEN']}"} if "TOKEN" in os.environ else {}
        try:
            async with websockets.connect(URL, additional_headers=headers) as ws:
                welcome = json.loads(await ws.recv())["metadata"]
                if resume:
                    await ws.send(json.dumps({"metadata": {"x-op": "x-resume", "x-id": "r1", **resume}}))
                else:
                    await ws.send(json.dumps(SUBSCRIBE))
                    resume = {"x-connection": welcome["x-connection"],
                              "x-resume-token": welcome["x-resume-token"], "x-seq": 0}
                async for frame in ws:
                    message = json.loads(frame)
                    metadata, body = message["metadata"], message.get("body")
                    op = metadata["x-op"]
                    if op == "x-notification":
                        resume["x-seq"] = metadata["x-seq"]
                        for entity in body["data"]:
                            print(entity["id"], entity.get("speed", {}).get("value"))
                    elif op == "x-gap":
                        print("missed changes: read /ngsi-ld/v1/entities?type=Vehicle again")
                    elif op == "x-result" and metadata.get("x-id") == "r1" and metadata["x-status"] != 200:
                        resume = None  # the connection is gone: subscribe again
                        break
                    elif op == "x-closing":
                        print("server closes:", metadata.get("x-reason"))
        except (OSError, websockets.WebSocketException) as error:
            print("reconnecting after", error)
        await asyncio.sleep(1)

asyncio.run(main())
```

## 6. Requirements

- **EP-106** [A][S] — the WebSocket surface of an Endpoint ([Requirements/endpoints](../Requirements/endpoints.md#23-live-access-and-the-open-data-portal)).
- **EP-107** [S] — the token never in a URL; connections capped per caller.
- **EP-114** [A][S] — one broker subscription per Endpoint and replica; your filters matched in the gateway.

## Related

- [API/02-endpoint-representations](02-endpoint-representations.md) — every standard an Endpoint serves, and how the open data portal lists them.
- [Requirements/endpoints](../Requirements/endpoints.md) — EP-104, EP-106 to EP-110, EP-114, EP-115.
- [Architecture/04-context-spaces-and-endpoints](../Architecture/04-context-spaces-and-endpoints.md) — the Endpoint model and its standards table.
- [Architecture/21-open-data-catalogue](../Architecture/21-open-data-catalogue.md) — the catalogue the Endpoint is published in.
