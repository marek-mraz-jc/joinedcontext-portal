import { useId, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useAccess } from "../../components/entities/AccessPanel";
import type { GrantDocument } from "../../components/entities/AccessPanel";
import { endpointUrl } from "../../components/endpoints/links";
import { Alert, Button, Field, Input, Select, Tabs, tabPanelProps } from "../../components/ui";

/** The reads the playground sends, each with the gateway action that decides it (EP-55). */
export const OPERATIONS = [
  { key: "list", action: "queryEntity" },
  { key: "count", action: "queryEntity" },
  { key: "one", action: "retrieveEntity" },
  { key: "types", action: "queryEntity" },
] as const;
export type Operation = (typeof OPERATIONS)[number]["key"];

export interface Fields {
  type: string;
  q: string;
  limit: string;
  id: string;
}

/** The path of one call, every value encoded; `undefined` while a field it needs is empty. */
export function requestOf(operation: Operation, fields: Fields): string | undefined {
  const query = new URLSearchParams();
  switch (operation) {
    case "types":
      return "/ngsi-ld/v1/types";
    case "one":
      return fields.id.trim() ? `/ngsi-ld/v1/entities/${encodeURIComponent(fields.id.trim())}` : undefined;
    case "list":
    case "count": {
      if (!fields.type.trim()) return undefined;
      query.set("type", fields.type.trim());
      if (fields.q.trim()) query.set("q", fields.q.trim());
      if (operation === "count") {
        query.set("count", "true");
        query.set("limit", "0");
      } else {
        const limit = Number.parseInt(fields.limit, 10);
        query.set("limit", String(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 10));
      }
      return `/ngsi-ld/v1/entities?${query.toString()}`;
    }
  }
}

/** The same call as a program sends it; a closed endpoint names a token, never carries one. */
export function snippetsOf(url: string, open: boolean): { curl: string; python: string; javascript: string } {
  const quoted = JSON.stringify(url);
  return {
    curl: open
      ? `curl -H 'Accept: application/ld+json' '${url}'`
      : `curl -H 'Accept: application/ld+json' -H "Authorization: Bearer $TOKEN" '${url}'`,
    python: [
      open ? "import requests" : "import os, requests",
      "",
      `answer = requests.get(${quoted}, headers={`,
      `    "Accept": "application/ld+json",`,
      ...(open ? [] : [`    "Authorization": "Bearer " + os.environ["TOKEN"],`]),
      "}, timeout=30)",
      "answer.raise_for_status()",
      "print(answer.json())",
    ].join("\n"),
    javascript: [
      `const answer = await fetch(${quoted}, {`,
      `  headers: {`,
      `    Accept: "application/ld+json",`,
      ...(open ? [] : ["    Authorization: `Bearer ${process.env.TOKEN}`,"]),
      "  },",
      "});",
      "if (!answer.ok) throw new Error(`HTTP ${answer.status}`);",
      "console.log(await answer.json());",
    ].join("\n"),
  };
}

/** The operations the caller's grants allow on this endpoint (EP-55): any type, any grant. */
export function allowedOperations(grants: GrantDocument | undefined): Operation[] {
  const actions = new Set((grants?.permissions ?? []).flatMap((entry) => entry.actions ?? []));
  return OPERATIONS.filter((operation) => actions.has(operation.action)).map((operation) => operation.key);
}

const LANGUAGES = ["curl", "python", "javascript"] as const;
/** Names, the same in every language. */
const LANGUAGE_NAMES: Record<(typeof LANGUAGES)[number], string> = { curl: "curl", python: "Python", javascript: "JavaScript" };

/**
 * An Endpoint's playground (T-3264): the reads the person may send, each parameter a field, the
 * answer as it came, pretty-printed, and the same call in curl, Python and JavaScript. Sent with
 * the person's own session, so the gateway answers with exactly their rights.
 */
export function Playground({ slug, types, open }: { slug: string; types: string[]; open: boolean }): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const access = useAccess(slug);
  const allowed = allowedOperations(access.data);
  const [chosen, setChosen] = useState<Operation | undefined>(undefined);
  // An endpoint that names no type starts on the list of its types, which needs no field.
  const operation =
    chosen && allowed.includes(chosen) ? chosen : types.length === 0 && allowed.includes("types") ? "types" : allowed[0];
  const [fields, setFields] = useState<Fields>({ type: types[0] ?? "", q: "", limit: "10", id: "" });
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>("curl");
  const [answer, setAnswer] = useState<{ status: number; text: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (access.isPending) {
    return <p className="text-caption text-fg-muted">{t("endpoints.playground.reading")}</p>;
  }
  if (allowed.length === 0 || operation === undefined) {
    return <p className="text-body text-fg-muted">{t("endpoints.playground.nothing")}</p>;
  }
  const path = requestOf(operation, fields);
  const url = path ? endpointUrl(slug, path) : undefined;
  const set = (key: keyof Fields) => (event: { target: { value: string } }) => setFields({ ...fields, [key]: event.target.value });

  const send = async () => {
    if (!url) return;
    setFailed(null);
    setSending(true);
    try {
      const response = await globalThis.fetch(
        new Request(url, { credentials: "same-origin", headers: { Accept: "application/ld+json" } }),
      );
      const text = await response.text();
      let shown = text;
      try {
        shown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON: the answer as it came.
      }
      setAnswer({ status: response.status, text: shown.slice(0, 20000) });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const snippets = url ? snippetsOf(url, open) : undefined;
  return (
    <div className="flex flex-col gap-3" data-testid="endpoint-playground">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-operation`} label={t("endpoints.playground.operation")}>
          <Select id={`${id}-operation`} value={operation} onChange={(event) => setChosen(event.target.value as Operation)}>
            {allowed.map((key) => (
              <option key={key} value={key}>
                {t(`endpoints.playground.operations.${key}`)}
              </option>
            ))}
          </Select>
        </Field>
        {operation === "list" || operation === "count" ? (
          <Field id={`${id}-type`} label={t("endpoints.playground.type")}>
            {types.length > 0 ? (
              <Select id={`${id}-type`} value={fields.type} onChange={set("type")}>
                {types.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id={`${id}-type`} value={fields.type} onChange={set("type")} placeholder="WeatherObserved" />
            )}
          </Field>
        ) : null}
        {operation === "list" || operation === "count" ? (
          <Field id={`${id}-q`} label={t("endpoints.playground.q")} description={t("endpoints.playground.qHint")}>
            <Input id={`${id}-q`} value={fields.q} onChange={set("q")} placeholder="temperature>20" spellCheck={false} />
          </Field>
        ) : null}
        {operation === "list" ? (
          <Field id={`${id}-limit`} label={t("endpoints.playground.limit")}>
            <Input id={`${id}-limit`} type="number" min={1} max={100} value={fields.limit} onChange={set("limit")} />
          </Field>
        ) : null}
        {operation === "one" ? (
          <Field id={`${id}-id`} label={t("endpoints.playground.id")}>
            <Input id={`${id}-id`} value={fields.id} onChange={set("id")} placeholder="urn:ngsi-ld:WeatherObserved:001" spellCheck={false} />
          </Field>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={sending}
          disabled={!url}
          disabledReason={url ? undefined : t("endpoints.playground.fill")}
          onClick={() => void send()}
        >
          {t("endpoints.playground.send")}
        </Button>
        {url ? <code className="break-all font-mono text-caption text-fg-muted">{url}</code> : null}
      </div>
      {failed ? (
        <Alert role="alert" tone="danger">
          {failed}
        </Alert>
      ) : null}
      {answer ? (
        <div className="flex flex-col gap-1">
          <p className="text-caption text-fg-muted" role="status">
            {t("endpoints.playground.answered", { status: answer.status })}
          </p>
          <pre className="max-h-80 overflow-auto rounded-md bg-surface-subtle p-2 font-mono text-caption" data-testid="playground-answer">
            {answer.text}
          </pre>
        </div>
      ) : null}
      {snippets ? (
        <div className="flex flex-col gap-2">
          <Tabs
            id={`${id}-code`}
            label={t("endpoints.playground.code")}
            tabs={LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAMES[value] }))}
            value={language}
            onChange={setLanguage}
          />
          <pre {...tabPanelProps(`${id}-code`, language)} className="overflow-x-auto rounded-md bg-surface-subtle p-2 font-mono text-caption">
            {snippets[language]}
          </pre>
          {!open ? <p className="text-caption text-fg-muted">{t("endpoints.page.firstCallToken")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
