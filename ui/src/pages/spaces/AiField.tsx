/**
 * The AI field of a data view (T-3111, ADR-N-042 §3.1/§3.6): one attribute of the rows on screen
 * filled from a prompt over each row's attributes — summarise, classify, translate.
 *
 * The page builds the request and shows what it costs before anything runs; the assistant then
 * reads the rows with the person's grants, prepares the values as a `write_entities` preview
 * (AG-78) and the person applies it from the browser with their own session, so the Endpoint's
 * Policy decides every write and the daily model caps of AG-97 count every call. The value lands
 * as a Property with `generatedFrom` and `generatedAt` beside it, so a reader sees where it came
 * from.
 */
import { useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { cellText } from "@joinedcontext/sdk";
import type { RichRow } from "@joinedcontext/sdk";
import { askAbout } from "../../assistant/state";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";

/** The most rows one request covers: what one `write_entities` preview may change (AG-78). */
export const AI_ROWS = 50;
/** The longest prompt the field takes. */
export const AI_PROMPT = 1000;

/** An attribute name an NGSI-LD Property can take. */
const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * What the request will cost, roughly, in model tokens: four characters a token over what the
 * model reads (the prompt, each row's attributes as text) and writes (about forty a row).
 */
export function estimateTokens(prompt: string, rows: RichRow[]): number {
  const read = rows.reduce(
    (sum, row) =>
      sum + row.id.length + Object.entries(row.cells).reduce((n, [attr, cell]) => n + attr.length + cellText(cell).length, 0),
    prompt.length,
  );
  return Math.ceil(read / 4) + rows.length * 40;
}

/** The request the assistant is handed, every rule of the write spelled out. */
export function aiFieldRequest(
  space: string,
  type: string,
  endpoint: string,
  attribute: string,
  prompt: string,
  rows: RichRow[],
  now: string = new Date().toISOString(),
): string {
  return [
    `Fill the attribute "${attribute}" of ${rows.length} ${type} entities of the space ${space}, through the Endpoint ${endpoint}.`,
    `For each entity, read its attributes and answer this prompt: ${prompt.trim()}`,
    `Write the answer with write_entities as a Property "${attribute}" whose value is the answer, with the sub-properties`,
    `"generatedFrom" (a Property holding the prompt above, word for word) and "generatedAt" (a Property holding "${now}").`,
    "Change no other attribute. Leave out an entity you cannot answer for, and say which and why.",
    "The entities:",
    ...rows.map((row) => `- ${row.id}`),
  ].join("\n");
}

export function AiFieldPanel({
  space,
  type,
  endpoints,
  rows,
}: {
  space: string;
  type: string;
  /** The names of the space's Endpoints, the first the one the request names. */
  endpoints: string[];
  /** The rows on screen; the request covers the first `AI_ROWS`. */
  rows: RichRow[];
}): JSX.Element {
  const { t } = useTranslation();
  const [attribute, setAttribute] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpoint, setEndpoint] = useState(endpoints[0] ?? "");
  const covered = rows.slice(0, AI_ROWS);
  const tokens = estimateTokens(prompt, covered);
  const attributeOk = ATTRIBUTE.test(attribute);
  const promptOk = prompt.trim() !== "" && prompt.length <= AI_PROMPT;
  const reason = !endpoint
    ? t("spaces.ai.noEndpoint")
    : !attributeOk
      ? t("spaces.ai.attributeHint")
      : !promptOk
        ? t("spaces.ai.promptHint", { count: AI_PROMPT })
        : undefined;

  return (
    <details className="rounded-lg border border-border p-3" data-testid="view-ai">
      <summary className="cursor-pointer text-body font-semibold text-fg">{t("spaces.ai.title")}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-body text-fg-muted">{t("spaces.ai.lead")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="ai-attribute"
            label={t("spaces.ai.attribute")}
            help={t("spaces.ai.attributeHint")}
            errors={attribute === "" || attributeOk ? undefined : [t("spaces.ai.attributeHint")]}
          >
            <Input id="ai-attribute" value={attribute} onChange={(event) => setAttribute(event.target.value)} />
          </Field>
          {endpoints.length > 1 ? (
            <Field id="ai-endpoint" label={t("spaces.ai.endpoint")}>
              <Select id="ai-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)}>
                {endpoints.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <Field id="ai-prompt" label={t("spaces.ai.prompt")} help={t("spaces.ai.promptHint", { count: AI_PROMPT })}>
          <Textarea id="ai-prompt" rows={3} maxLength={AI_PROMPT} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <p className="text-caption text-fg-muted" data-testid="ai-budget">
          {t("spaces.ai.budget", { rows: covered.length, tokens })}
          {rows.length > AI_ROWS ? ` ${t("spaces.ai.cut", { count: AI_ROWS })}` : ""}
        </p>
        <Button
          className="w-fit"
          disabled={reason !== undefined || covered.length === 0}
          disabledReason={reason ?? t("spaces.inside.dataEmpty")}
          onClick={() => askAbout(aiFieldRequest(space, type, endpoint, attribute, prompt, covered))}
        >
          {t("spaces.ai.ask")}
        </Button>
      </div>
    </details>
  );
}
