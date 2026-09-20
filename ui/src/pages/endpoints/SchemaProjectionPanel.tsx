import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import type { ProblemDetails } from "../../api/client";
import { SCHEMA_FORMALISMS } from "../../schemas/kinds";
import type { SchemaFormalism } from "../../schemas/kinds";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeaderCell,
} from "../../components/ui";

/**
 * What an Endpoint publishes of its model, and which attributes it holds back (EP-46, EP-61).
 *
 * The attribute names are read from the endpoint's own schema surface rather than from the
 * DataModel manifest, because the surface is already projected to the policy: what it lists
 * is what this endpoint may publish at all, so ticking a box here can only narrow further
 * (R9, EP-07). An attribute the steward hides is struck from the published column and never
 * reaches the preview, which is the same rule the gateway applies to the served document.
 */

/** One class of the published JSON Schema and the attributes it still carries. */
export interface PublishedType {
  name: string;
  attributes: string[];
}

interface SchemaIndex {
  models?: { name?: string; version?: number }[];
}

/** Reads `$defs` of the projected draft-07 document the endpoint serves. */
export function publishedTypes(document: unknown): PublishedType[] {
  const defs = (document as { $defs?: Record<string, unknown> } | null)?.$defs;
  if (!defs) {
    return [];
  }
  return Object.entries(defs)
    .map(([name, definition]) => ({
      name,
      attributes: Object.keys(
        (definition as { properties?: Record<string, unknown> })?.properties ?? {},
      ).sort(),
    }))
    .filter((type) => type.attributes.length > 0);
}

/** A `Request` rather than a bare URL, so the caller reads like every other call the app makes. */
async function get(url: string, accept: string): Promise<Response> {
  const answer = await fetch(new Request(url, { headers: { Accept: accept } }));
  if (!answer.ok) {
    // The status alone was the whole message, so every caller that shows a failed schema fetch
    // showed a person the bare number "502" and the Problem Details sentence the surface had
    // just sent was dropped on the floor. An unreadable body leaves the status, as before.
    let detail: string | undefined;
    try {
      const problem = (await answer.clone().json()) as ProblemDetails;
      detail = typeof problem.detail === "string" ? problem.detail : undefined;
    } catch {
      detail = undefined;
    }
    throw new ApiError(answer.status, detail ?? String(answer.status));
  }
  return answer;
}

export async function fetchJson(url: string): Promise<unknown> {
  return (await get(url, "application/json")).json();
}

async function fetchText(url: string): Promise<string> {
  return (await get(url, "*/*")).text();
}

export interface SchemaProjectionPanelProps {
  /** The endpoint's slug; the schema surface lives under it. */
  slug: string;
  /** Attribute names this endpoint hides, `spec.projection.hiddenAttributes`. */
  hidden: string[];
  onHiddenChange: (hidden: string[]) => void;
}

export function SchemaProjectionPanel({
  slug,
  hidden,
  onHiddenChange,
}: SchemaProjectionPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [formalism, setFormalism] = useState<SchemaFormalism>("json-schema");
  const [typed, setTyped] = useState("");
  const base = `${window.location.origin}/api/endpoint/${slug}/schema`;

  const index = useQuery({
    queryKey: ["endpoint-schema-index", slug],
    retry: false,
    queryFn: () => fetchJson(`${base}/index.json`) as Promise<SchemaIndex>,
  });

  // The major of the first model is the version segment every artifact of it lives under.
  const version = index.data?.models?.[0]?.version ?? 1;
  const artifactUrl = `${base}/v${version}/${formalism}`;

  const schema = useQuery({
    queryKey: ["endpoint-schema-artifact", slug, version, formalism],
    enabled: index.isSuccess,
    retry: false,
    queryFn: () =>
      formalism === "json-schema"
        ? (fetchJson(artifactUrl) as Promise<unknown>)
        : fetchText(artifactUrl),
  });

  const types = useMemo(
    () => (formalism === "json-schema" ? publishedTypes(schema.data) : []),
    [formalism, schema.data],
  );

  const toggle = (attribute: string) => {
    onHiddenChange(
      hidden.includes(attribute)
        ? hidden.filter((name) => name !== attribute)
        : [...hidden, attribute],
    );
  };

  return (
    <section aria-labelledby="projection-heading" className="space-y-3">
      <h3 id="projection-heading" className="text-base font-semibold">
        {t("endpoints.projection.title")}
      </h3>
      <p className="text-sm text-surface-fg/70">{t("endpoints.projection.hint")}</p>

      <Field id="projection-formalism" label={t("endpoints.projection.formalism")}>
        <Select
          id="projection-formalism"
          value={formalism}
          onChange={(event) => setFormalism(event.target.value as SchemaFormalism)}
        >
          {SCHEMA_FORMALISMS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </Field>
      <p className="break-all font-mono text-caption text-fg-muted">{artifactUrl}</p>

      {index.isPending || schema.isPending ? (
        <p role="status">{t("endpoints.projection.loading")}</p>
      ) : null}

      {index.isError ? (
        <p className="text-sm text-surface-fg/70">{t("endpoints.projection.unavailable")}</p>
      ) : null}

      {index.isSuccess && schema.isError ? (
        <p className="text-sm text-surface-fg/70">{t("endpoints.projection.notCompiled")}</p>
      ) : null}

      {formalism !== "json-schema" && schema.isSuccess ? (
        <pre className="max-h-64 overflow-auto rounded border border-border bg-surface-subtle p-3 text-xs">
          {String(schema.data)}
        </pre>
      ) : null}

      {types.map((type) => {
        // The preview is built by subtraction, so a hidden attribute cannot appear in it
        // even if the published document still carries it.
        const effective = type.attributes.filter((name) => !hidden.includes(name));
        return (
          // The class name is a heading a person reads, and the table's own name for a screen
          // reader: the shared Table hides its caption, so it is written once above and passed in.
          <section key={type.name} aria-labelledby={`projection-${type.name}`} className="space-y-1">
            <h3 id={`projection-${type.name}`} className="font-medium text-fg">
              {type.name}
            </h3>
            <Table caption={type.name}>
              <TableHead>
                <TableHeaderCell>{t("endpoints.projection.attribute")}</TableHeaderCell>
                <TableHeaderCell>{t("endpoints.projection.hide")}</TableHeaderCell>
              </TableHead>
              <TableBody>
                {type.attributes.map((attribute) => (
                  <TableRow key={attribute}>
                    <TableRowHeaderCell className="font-mono font-normal">
                      {attribute}
                    </TableRowHeaderCell>
                    <TableCell>
                      <Checkbox
                        // The column header says "Hide"; the box itself still has to name the
                        // attribute it hides, or a screen reader reads a row of bare checkboxes.
                        label={
                          <span className="sr-only">{`${t("endpoints.projection.hide")} ${attribute}`}</span>
                        }
                        checked={hidden.includes(attribute)}
                        onChange={() => toggle(attribute)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* The summary of the table above, not a row of it: a `tfoot` cell spanning both
                columns was read as data by a screen reader walking the rows. */}
            <p className="text-sm">
              <span className="font-medium">{t("endpoints.projection.effective")}: </span>
              {effective.length > 0 ? (
                <span className="font-mono">{effective.join(", ")}</span>
              ) : (
                <span className="text-fg-muted">{t("endpoints.projection.none")}</span>
              )}
            </p>
          </section>
        );
      })}

      <div className="flex items-end gap-2">
        <Field id="projection-typed" label={t("endpoints.projection.addHidden")} className="flex-1">
          <Input
            id="projection-typed"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        <Button
          disabled={typed.trim() === "" || hidden.includes(typed.trim())}
          onClick={() => {
            onHiddenChange([...hidden, typed.trim()]);
            setTyped("");
          }}
        >
          {t("endpoints.projection.add")}
        </Button>
      </div>

      {hidden.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {hidden.map((attribute) => (
            <li key={attribute}>
              <Button
                variant="secondary"
                size="xs"
                className="font-mono"
                onClick={() => toggle(attribute)}
              >
                {attribute}
                <span aria-hidden="true">×</span>
                {/* This chip takes the attribute back OUT of the hidden list, and announced
                    "Hide": someone unhiding a field heard that they were hiding it, and the
                    endpoint then published a field they believed they had withheld. */}
                <span className="sr-only">{t("endpoints.projection.unhide")}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
