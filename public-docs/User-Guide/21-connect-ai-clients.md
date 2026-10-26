---
sidebar_position: 23
title: Connect Claude, ChatGPT and Claude Code
description: Add the Portal's MCP server to claude.ai, Claude Desktop, ChatGPT or Claude Code with a fixed OAuth client id, and what each sign-in error means.
---

# Connect Claude, ChatGPT and Claude Code

The Portal runs an MCP server: an AI client connected to it lists your projects, reads manifests and prepares changes under your own sign-in, and every change it prepares waits for a person's approval like any other draft. This page shows how to add it to claude.ai or Claude Desktop, to ChatGPT, and to Claude Code. Each client signs you in through the platform's login page; nobody hands the client a password or a secret.

## 1. What Every Client Needs

| Setting | Value | Example on the demonstration instance |
|---|---|---|
| Server address | `https://portal.{domain}/api/v1/mcp` | `https://portal.dev.joinedcontext.com/api/v1/mcp` |
| Authentication | OAuth | |
| OAuth Client ID, web and phone clients | `mcp-mobile` | `mcp-mobile` |
| OAuth Client ID, clients on your computer | `mcp-local` | `mcp-local` |
| OAuth Client Secret | none: leave the field empty | |
| Scope, when the client asks for one | `openid mcp:portal` | |

The platform does not let a client register itself: a client that tries finds no registration address and needs the Client ID from the table. Both clients are public, so they carry no secret, and both require PKCE, which every client on this page sends by itself.

The token a client receives names the Portal's MCP server and nothing else. It carries your platform roles and groups, so the client sees exactly what you see in the Portal and no more. A token of `mcp-local` lasts five minutes and is refreshed while your sign-in lasts, at most eight hours; then the client asks you to sign in again.

## 2. claude.ai and Claude Desktop

Claude Desktop uses the connectors of your claude.ai account, so one setup serves both.

1. On claude.ai open Settings, then Connectors, and choose to add a custom connector.
2. Enter a name, for example `joinedcontext`, and the server address `https://portal.dev.joinedcontext.com/api/v1/mcp`.
3. Open Advanced settings (or, in the two-step form, choose to use your own OAuth client) and enter the OAuth Client ID `mcp-mobile`. Leave the OAuth Client Secret empty.
4. Add the connector and choose Connect. The platform's login page opens; sign in, and the browser returns to claude.ai.

The authentication settings of a connector cannot be changed afterwards: to correct the Client ID, remove the connector and add it again.

## 3. ChatGPT

1. In ChatGPT open Settings, then Apps and Connectors, and create a custom connector (it needs developer mode on your plan).
2. Enter a name and the server address `https://portal.dev.joinedcontext.com/api/v1/mcp`, and choose OAuth as the authentication.
3. Enter the OAuth Client ID `mcp-mobile`, leave the secret empty and, if a scope field is shown, enter `openid mcp:portal`.
4. Create the connector and sign in on the platform's login page when it opens.

## 4. Claude Code

Claude Code receives the sign-in on a port of your own computer, so it uses the Client ID `mcp-local`. Add the server once:

```bash
claude mcp add --transport http --client-id mcp-local joinedcontext https://portal.dev.joinedcontext.com/api/v1/mcp
```

Claude Code asks whether the client has a secret only when you pass `--client-secret`; do not pass it. Then run `/mcp` inside Claude Code, pick `joinedcontext` and choose to authenticate: the browser opens the platform's login page and comes back to `http://localhost:{port}/callback`. Any port works, so `--callback-port` is optional. Other MCP clients on your computer, such as an IDE or MCP Inspector, work the same way when their callback is `http://localhost:{port}/callback` or `http://127.0.0.1:{port}/callback`.

## 5. When Signing In Fails

| What you see | Why | What to do |
|---|---|---|
| The login page says: The app asked to sign you in in a way this platform does not accept (redirect_uri). | The client's callback address is not one the Client ID accepts, for example Claude Code with `mcp-mobile`. | Use `mcp-local` for a client on your computer and `mcp-mobile` for claude.ai, Claude Desktop and ChatGPT. A local client's callback path must be `/callback`. |
| The client reports that it cannot register, or that dynamic client registration failed. | The client was added without a Client ID and tried to register itself, which the platform does not allow. | Remove the connector and add it again with the Client ID from the table. |
| The client connects but every call answers `401` with `WWW-Authenticate: Bearer resource_metadata=…`. | The token lacks the scope `mcp:portal`, so it does not name the Portal. | Enter the scope `openid mcp:portal` if the client has a scope field, or remove and re-add the connector so it reads the scope from the server again. |
| A tool answers that you may not do this. | The client acts with your rights, and your role does not allow the action. | Ask a project administrator for the role; see [Users, Roles and Approvals](07-users-roles-approvals.md). |

## Related

- [Working with AI Agents](08-working-with-ai-agents.md): the assistant, agent runs and the Endpoint MCP addresses
- [Users, Roles and Approvals](07-users-roles-approvals.md)
- [Agents and MCP](../Architecture/07-agents-and-mcp.md)
