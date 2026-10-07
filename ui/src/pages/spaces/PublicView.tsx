/**
 * A data view published as a public link (T-3108, API/01 §33, ADR-N-042 §3.5).
 *
 * `SharePanel` publishes one type of a space: a public Endpoint narrowed to that type and to the
 * attributes the person chose, rendered by `propose-endpoint` and proposed as one Change with its
 * Policy. `PublicViewPage` is the link: a read-only page whose every read is an anonymous read of
 * that Endpoint, so the gateway decides what the link shows.
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import type { Change, ResourceProposal } from "../../api/manifest";
import { useProposal } from "../../api/proposal";
import { ChangeNotice } from "../../components/ChangeNotice";
import { endpointUrl } from "../../components/endpoints/links";
import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { DNS1123 } from "../../schemas/kinds";

/** The rows a published view shows. */
export const PUBLIC_ROWS = 100;

/** A name the Endpoint can take: the space and the type, lower case, at most 63 characters. */
export function publicName(space: string, type: string): string {
  const base = `${space}-${type}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
  return `${base.slice(0, 55).replace(/^-+|-+$/g, "")}-public`;
}

/** What `propose-endpoint` is asked: this type alone, public, the attributes not shown hidden. */
export function publishRequest(
  space: string,
  name: string,
  type: string,
  attributes: string[],
  shown: string[],
): Record<string, unknown> {
  return {
    contextSpace: space,
    name,
    audience: "public",
    entityTypes: [type],
    hiddenAttributes: attributes.filter((attr) => !shown.includes(attr)),
  };
}

interface Rendering {
  slug?: string;
  endpoint: ResourceProposal;
  policies: ResourceProposal[];
}

export function SharePanel({
  project,
  space,
  type,
  attributes,
}: {
  project: string;
  space: string;
  type: string;
  /** The type's attributes, from the model or the rows read. */
  attributes: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(() => publicName(space, type));
  const [shown, setShown] = useState<string[]>(attributes);
  const [change, setChange] = useState<Change | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const proposal = useProposal(project, "endpoints", setChange);
  const nameOk = new RegExp(DNS1123).test(name) && name.length <= 63;

  const publish = async () => {
    setFailed(null);
    try {
      const rendering = (await unwrap(
        await api.POST("/api/v1/projects/{project}/assistant/propose-endpoint", {
          params: { path: { project } },
          // The route documents its body as an object of no named members (API/01 §19).
          body: publishRequest(space, name, type, attributes, shown) as Record<string, never>,
        }),
      )) as unknown as Rendering;
      setSlug(rendering.slug ?? null);
      proposal.mutation.mutate({ body: rendering.endpoint, create: true, bundle: rendering.policies });
    } catch (error) {
      setFailed(error instanceof ApiError ? (error.problem?.detail ?? error.message) : String(error));
    }
  };

  return (
    <details className="rounded-lg border border-border p-3" data-testid="view-share">
      <summary className="cursor-pointer text-body font-semibold text-fg">{t("spaces.share.title")}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-body text-fg-muted">{t("spaces.share.lead", { type })}</p>
        <Field
          id="share-name"
          label={t("spaces.share.name")}
          help={t("spaces.share.nameHint")}
          errors={nameOk ? undefined : [t("spaces.share.nameHint")]}
        >
          <Input id="share-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="text-caption font-semibold text-fg">{t("spaces.share.shown")}</legend>
          {attributes.map((attr) => (
            <Checkbox
              key={attr}
              label={attr}
              checked={shown.includes(attr)}
              onChange={(event) =>
                setShown(event.target.checked ? [...shown, attr] : shown.filter((one) => one !== attr))
              }
            />
          ))}
        </fieldset>
        {failed || proposal.error ? (
          <Alert role="alert" tone="danger">
            {failed ?? proposal.error}
          </Alert>
        ) : null}
        <Button
          className="w-fit"
          disabled={!nameOk || proposal.mutation.isPending}
          disabledReason={!nameOk ? t("spaces.share.nameHint") : t("app.loading")}
          onClick={() => void publish()}
        >
          {t("spaces.share.publish")}
        </Button>
        {change ? (
          <div className="flex flex-col gap-1">
            <ChangeNotice change={change} project={project} />
            {slug ? (
              <p className="text-body text-fg [overflow-wrap:anywhere]" data-testid="share-link">
                {t("spaces.share.link", { url: `${window.location.origin}/v/${slug}` })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** One anonymous read of a public Endpoint; the gateway decides what it answers. */
async function readPublic(slug: string, path: string): Promise<unknown> {
  const response = await globalThis.fetch(
    new Request(endpointUrl(slug, path), { headers: { Accept: "application/json" }, credentials: "omit" }),
  );
  if (!response.ok) throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
  return response.json();
}

/** The value of one key-value attribute as text. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** The page at `/v/{slug}`: what the public Endpoint answers anybody, read-only. */
export function PublicViewPage({ slug }: { slug: string }): JSX.Element {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState("");
  const types = useQuery({
    queryKey: ["public-view", slug, "types"],
    retry: false,
    queryFn: async () => {
      const body = (await readPublic(slug, "/ngsi-ld/v1/types")) as { typeList?: unknown } | unknown[];
      const list = Array.isArray(body) ? body : (body as { typeList?: unknown }).typeList;
      return (Array.isArray(list) ? list : []).filter((item): item is string => typeof item === "string");
    },
  });
  const type = types.data?.includes(chosen) ? chosen : (types.data?.[0] ?? "");
  const rows = useQuery({
    queryKey: ["public-view", slug, "rows", type],
    enabled: type !== "",
    retry: false,
    queryFn: async () => {
      const body = await readPublic(
        slug,
        `/ngsi-ld/v1/entities?type=${encodeURIComponent(type)}&limit=${PUBLIC_ROWS}&options=keyValues`,
      );
      return (Array.isArray(body) ? body : []) as Record<string, unknown>[];
    },
  });
  const columns = useMemo(
    () =>
      [...new Set((rows.data ?? []).flatMap((row) => Object.keys(row)))].filter(
        (key) => !["id", "type", "@context"].includes(key),
      ),
    [rows.data],
  );

  // Every state keeps the page's one heading: the link's own name until a type is read.
  if (types.isPending || types.isError || types.data.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="public-view">
        <h1 className="text-title font-semibold text-fg">{slug}</h1>
        <p className="text-body text-fg-muted" role="status">
          {types.isPending ? t("app.loading") : t("spaces.share.notPublished")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="public-view">
      <h1 className="text-title font-semibold text-fg">{type}</h1>
      {types.data.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("spaces.share.types")}>
          {types.data.map((name) => (
            <Button key={name} size="sm" variant={name === type ? "primary" : "secondary"} aria-pressed={name === type} onClick={() => setChosen(name)}>
              {name}
            </Button>
          ))}
        </div>
      ) : null}
      {rows.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {rows.isError ? (
        <Alert role="alert" tone="danger">
          {rows.error instanceof Error ? rows.error.message : t("app.error.generic")}
        </Alert>
      ) : null}
      {rows.data ? (
        <>
          <p className="text-caption text-fg-muted">
            {t(rows.data.length >= PUBLIC_ROWS ? "spaces.share.first" : "spaces.share.count", { count: rows.data.length })}
          </p>
          <Table caption={type}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t("entityGrid.id")}</TableHeaderCell>
                {columns.map((column) => (
                  <TableHeaderCell key={column}>{column}</TableHeaderCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.data.map((row) => (
                <TableRow key={String(row.id)}>
                  <TableCell className="font-mono text-caption [overflow-wrap:anywhere]">{String(row.id)}</TableCell>
                  {columns.map((column) => (
                    <TableCell key={column} className="[overflow-wrap:anywhere]">
                      {textOf(row[column])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : null}
    </div>
  );
}
