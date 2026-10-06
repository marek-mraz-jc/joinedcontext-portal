/**
 * The API of one entity type of a space (T-3110, ADR-N-042 §3.6): the calls each Endpoint of the
 * space answers for that type, one tried live with the person's session, how a program gets its
 * own scoped token (a ServiceAccount), and the webhooks that watch the type, which are NGSI-LD
 * subscriptions proposed as Changes like every other manifest.
 */
import { useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { putDraft } from "../../api/drafts";
import { asManifests } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { useBranding } from "../../branding";
import { endpointUrl, representationUrl, servedRepresentations } from "../../components/endpoints/links";
import { Alert, Button, Card, ExternalLink } from "../../components/ui";

/** The calls one Endpoint answers for one type, as a program writes them. */
export function callsOf(
  slug: string,
  type: string,
  served: string[],
  domain: string | undefined,
): { key: string; url: string }[] {
  const t = encodeURIComponent(type);
  const calls = [
    { key: "list", url: endpointUrl(slug, `/ngsi-ld/v1/entities?type=${t}&limit=10`) },
    { key: "count", url: endpointUrl(slug, `/ngsi-ld/v1/entities?type=${t}&count=true&limit=0`) },
    { key: "one", url: endpointUrl(slug, `/ngsi-ld/v1/entities/{id}`) },
    { key: "history", url: endpointUrl(slug, `/ngsi-ld/v1/temporal/entities?type=${t}&lastN=10`) },
  ];
  for (const representation of served.filter((rep) => rep !== "ngsi-ld")) {
    calls.push({ key: representation, url: representationUrl(slug, representation, domain) });
  }
  return calls;
}

/** The subscriptions of the space that watch the type: by its label and an entity selector. */
export function webhooksOf(subscriptions: Manifest[], space: string, type: string): Manifest[] {
  return subscriptions.filter((subscription) => {
    const labels = subscription.metadata.labels ?? {};
    const spec = subscription.spec as { contextSpaceRef?: unknown; entities?: { type?: unknown }[] };
    const inSpace = labels["joinedcontext.com/space"] === space || spec.contextSpaceRef === space;
    return inSpace && (spec.entities ?? []).some((selector) => selector.type === type);
  });
}

/** A draft name a new webhook can take: the type in lower case and four random letters. */
function draftName(type: string): string {
  const base = type.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "type";
  return `webhook-${base}-${Math.random().toString(36).slice(2, 6)}`;
}

export function TypeApi({
  project,
  space,
  type,
  endpoints,
}: {
  project: string;
  space: string;
  type: string;
  /** The space's Endpoints. */
  endpoints: Manifest[];
}): JSX.Element {
  const { t } = useTranslation();
  const { domain } = useBranding();
  const navigate = useNavigate();
  const [tried, setTried] = useState<{ slug: string; status: number; text: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const subscriptions = useQuery({
    queryKey: queryKeys.list(project, "subscriptions"),
    retry: false,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "subscriptions" } },
        }),
      ),
  });
  const hooks = webhooksOf(asManifests(subscriptions.data?.items ?? []), space, type);
  const served = endpoints.filter((endpoint) => typeof (endpoint.spec as { slug?: unknown }).slug === "string");

  const tryIt = async (slug: string) => {
    setFailed(null);
    try {
      const response = await globalThis.fetch(
        new Request(endpointUrl(slug, `/ngsi-ld/v1/entities?type=${encodeURIComponent(type)}&limit=1`), {
          headers: { Accept: "application/ld+json" },
        }),
      );
      const text = await response.text();
      let shown = text;
      try {
        shown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON: the answer as it came.
      }
      setTried({ slug, status: response.status, text: shown.slice(0, 8000) });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  const newWebhook = async () => {
    setFailed(null);
    const name = draftName(type);
    try {
      await putDraft(project, "Subscription", name, {
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "Subscription",
        metadata: { name, namespace: project, labels: { "joinedcontext.com/space": space } },
        spec: { entities: [{ type }], notification: { endpoint: { uri: "", accept: "application/json" } } },
      });
      await navigate({ href: `/projects/${encodeURIComponent(project)}/subscriptions?draft=${encodeURIComponent(name)}` });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="view-api">
      <p className="text-body text-fg-muted">{t("spaces.api.lead", { type })}</p>
      {failed ? (
        <Alert role="alert" tone="danger">
          {failed}
        </Alert>
      ) : null}
      {served.length === 0 ? <p className="text-body text-fg-muted">{t("spaces.api.noEndpoint")}</p> : null}
      {served.map((endpoint) => {
        const slug = (endpoint.spec as { slug: string }).slug;
        return (
          <Card key={endpoint.metadata.name} className="flex flex-col gap-2 p-3">
            <h3 className="text-body font-semibold text-fg">
              {t("spaces.api.endpoint", { name: endpoint.metadata.name })}
            </h3>
            <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
              {callsOf(slug, type, servedRepresentations(endpoint.spec as Record<string, unknown>), domain).map((call) => (
                <div key={call.key} className="contents">
                  <dt className="text-caption font-semibold text-fg-muted">{t(`spaces.api.call.${call.key}`, { defaultValue: call.key })}</dt>
                  <dd className="font-mono text-caption text-fg [overflow-wrap:anywhere]">{call.url}</dd>
                </div>
              ))}
            </dl>
            <pre className="overflow-x-auto rounded-md bg-surface-subtle p-2 font-mono text-caption">
              {`curl -H "Authorization: Bearer $TOKEN" \\\n  "${endpointUrl(slug, `/ngsi-ld/v1/entities?type=${encodeURIComponent(type)}&limit=10`)}"`}
            </pre>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => void tryIt(slug)}>
                {t("spaces.api.try")}
              </Button>
              <ExternalLink href={endpointUrl(slug, "/")} className="text-caption">
                {t("spaces.api.index")}
              </ExternalLink>
            </div>
            {tried?.slug === slug ? (
              <div className="flex flex-col gap-1">
                <p className="text-caption text-fg-muted" role="status">
                  {t("spaces.api.answered", { status: tried.status })}
                </p>
                <pre className="max-h-64 overflow-auto rounded-md bg-surface-subtle p-2 font-mono text-caption" data-testid="api-tried">
                  {tried.text}
                </pre>
              </div>
            ) : null}
          </Card>
        );
      })}

      <section aria-labelledby="api-tokens" className="flex flex-col gap-1">
        <h3 id="api-tokens" className="text-body font-semibold text-fg">
          {t("spaces.api.tokens")}
        </h3>
        <p className="text-body text-fg-muted">{t("spaces.api.tokensLead")}</p>
        <Link
          to="/projects/$project/settings/$tab"
          params={{ project, tab: "service-accounts" }}
          className="text-body text-primary-soft-fg underline-offset-2 hover:underline"
        >
          {t("spaces.api.tokensLink")}
        </Link>
      </section>

      <section aria-labelledby="api-webhooks" className="flex flex-col gap-2">
        <h3 id="api-webhooks" className="text-body font-semibold text-fg">
          {t("spaces.api.webhooks")}
        </h3>
        <p className="text-body text-fg-muted">{t("spaces.api.webhooksLead", { type })}</p>
        {hooks.length === 0 ? (
          <p className="text-caption text-fg-muted">{t("spaces.api.noWebhook")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {hooks.map((hook) => {
              const uri = (hook.spec as { notification?: { endpoint?: { uri?: unknown } } }).notification?.endpoint?.uri;
              return (
                <li key={hook.metadata.name} className="text-body [overflow-wrap:anywhere]">
                  <span className="font-semibold">{hook.metadata.name}</span>{" "}
                  <span className="font-mono text-caption text-fg-muted">{typeof uri === "string" ? uri : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
        <Button size="sm" variant="secondary" className="w-fit" onClick={() => void newWebhook()}>
          {t("spaces.api.newWebhook")}
        </Button>
      </section>
    </div>
  );
}
