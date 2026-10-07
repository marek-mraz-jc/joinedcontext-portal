import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox, ExternalLink, Field, Textarea } from "../../components/ui";
import { useBranding } from "../../branding";
import { askAssistant, embedSnippet } from "./knowledge";
import type { ChatEvent, ChatTurn, Citation } from "./knowledge";
import { reasonOf } from "../../components/forms/widgets/ListFailed";

/** What the panel shows of one turn: the person's question or the assistant's answer as it grows. */
interface Shown {
  role: "user" | "assistant";
  text: string;
  reading?: string;
  tools: { tool: string; endpoint?: string; status: string }[];
  scripts: { code: string; result: string }[];
  citations: Citation[];
  error?: string;
}

/** The turns the next question sends back, as API/05 §1.1 bounds them. */
const HISTORY = 6;
const MAX_CHARS = 4_000;

function apply(turn: Shown, event: ChatEvent): Shown {
  switch (event.name) {
    case "tool":
      return {
        ...turn,
        reading: event.status === "started" ? (event.endpoint ?? event.tool) : turn.reading,
        tools: [...turn.tools, { tool: event.tool, endpoint: event.endpoint, status: event.status }],
      };
    case "script":
      return { ...turn, scripts: [...turn.scripts, { code: event.code, result: event.output ?? event.error ?? "" }] };
    case "answer":
      return { ...turn, text: event.text, reading: undefined };
    case "citations":
      return { ...turn, citations: event.citations };
    case "error":
      return { ...turn, error: event.detail, reading: undefined };
    default:
      return turn;
  }
}

/**
 * The knowledge assistant as the signed-in person asks it (API/05 §1.7, AG-115): the same events
 * the public widget shows, the answer streamed, the person's own connectors switchable. Nothing
 * is kept past the dialog: the conversation lives in this panel, as in the widget.
 */
export function AssistantChat({
  project,
  deployment,
  connectors,
}: {
  project: string;
  deployment: string;
  connectors: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<Shown[]>([]);
  const [question, setQuestion] = useState("");
  const [on, setOn] = useState<string[]>(connectors);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const conversation = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const message = question.trim();
    if (!message || busy) return;
    const history: ChatTurn[] = turns
      .filter((turn) => turn.text && !turn.error)
      .slice(-HISTORY)
      .map((turn) => ({ role: turn.role, text: turn.text.slice(0, MAX_CHARS) }));
    setTurns((all) => [
      ...all,
      { role: "user", text: message, tools: [], scripts: [], citations: [] },
      { role: "assistant", text: "", tools: [], scripts: [], citations: [] },
    ]);
    setQuestion("");
    setFailure(null);
    setBusy(true);
    abort.current = new AbortController();
    try {
      await askAssistant(
        project,
        deployment,
        {
          conversation: conversation.current,
          message,
          history,
          connectors: connectors.length > 0 ? on : undefined,
        },
        (streamed) => {
          if (streamed.name === "conversation") conversation.current = streamed.id;
          setTurns((all) => [...all.slice(0, -1), apply(all[all.length - 1], streamed)]);
        },
        abort.current.signal,
      );
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      setTurns((all) => all.slice(0, -1));
      setFailure(reasonOf(error, t("knowledge.chat.failed")));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="space-y-3">
      {connectors.length > 0 ? (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="mb-1 text-caption text-fg-muted">{t("knowledge.chat.connectors")}</legend>
          {connectors.map((name) => (
            <Checkbox
              key={name}
              label={name}
              checked={on.includes(name)}
              onChange={(change) =>
                setOn((current) =>
                  change.target.checked ? [...current, name] : current.filter((other) => other !== name),
                )
              }
            />
          ))}
        </fieldset>
      ) : null}
      <ol aria-live="polite" aria-label={t("knowledge.chat.conversation")} className="max-h-96 space-y-3 overflow-y-auto">
        {turns.map((turn, index) => (
          <li
            key={index}
            className={turn.role === "user" ? "ml-8 rounded-md bg-surface-subtle p-3" : "mr-8 rounded-md border border-border p-3"}
          >
            <span className="sr-only">{turn.role === "user" ? t("knowledge.chat.you") : t("knowledge.chat.assistant")}: </span>
            {turn.role === "assistant" && !turn.text && !turn.error ? (
              <p role="status" className="text-fg-muted">
                {turn.reading ? t("knowledge.chat.reading", { name: turn.reading }) : t("knowledge.chat.thinking")}
              </p>
            ) : null}
            {turn.text ? <p className="whitespace-pre-wrap">{turn.text}</p> : null}
            {turn.error ? (
              <Alert role="alert" tone="danger">
                {turn.error}
              </Alert>
            ) : null}
            {turn.tools.some((tool) => tool.status === "failed") ? (
              <p className="text-caption text-fg-muted">
                {t("knowledge.chat.toolFailed", {
                  names: turn.tools
                    .filter((tool) => tool.status === "failed")
                    .map((tool) => tool.endpoint ?? tool.tool)
                    .join(", "),
                })}
              </p>
            ) : null}
            {turn.scripts.map((script, n) => (
              <details key={n} className="mt-2 text-caption">
                <summary className="cursor-pointer">{t("knowledge.chat.script")}</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-surface-subtle p-2">{script.code}</pre>
                <pre className="mt-1 overflow-x-auto rounded bg-surface-subtle p-2">{script.result}</pre>
              </details>
            ))}
            {turn.citations.length > 0 ? (
              <ol aria-label={t("knowledge.chat.sources")} className="mt-2 list-decimal pl-6 text-caption">
                {turn.citations.map((citation) => (
                  <li key={citation.n} value={citation.n}>
                    {citation.url ? (
                      <ExternalLink href={citation.url}>{citation.url}</ExternalLink>
                    ) : (
                      [citation.tool, citation.endpoint].filter(Boolean).join(" · ")
                    )}
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
      {failure ? (
        <Alert role="alert" tone="danger">
          {failure}
        </Alert>
      ) : null}
      <form onSubmit={(event) => void send(event)} className="space-y-2">
        <Field id={`knowledge-chat-${deployment}`} label={t("knowledge.chat.question")}>
          <Textarea
            id={`knowledge-chat-${deployment}`}
            ref={input}
            rows={2}
            maxLength={MAX_CHARS}
            value={question}
            onChange={(change) => setQuestion(change.target.value)}
            onKeyDown={onKey}
          />
        </Field>
        <Button type="submit" disabled={busy || question.trim() === ""} loading={busy}>
          {t("knowledge.chat.send")}
        </Button>
      </form>
    </div>
  );
}

/** The iframe a site pastes, with a copy button; the site must be one of the allowed origins. */
export function EmbedSnippet({ publicId, title }: { publicId: string; title: string }): JSX.Element {
  const { t } = useTranslation();
  const branding = useBranding();
  const [copied, setCopied] = useState(false);
  if (!branding.domain) {
    return <p>{t("knowledge.embed.noDomain")}</p>;
  }
  const snippet = embedSnippet(branding.domain, publicId, title);
  return (
    <div className="space-y-3">
      <p>{t("knowledge.embed.intro")}</p>
      <pre aria-label={t("knowledge.embed.snippet")} className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-subtle p-3 text-caption">
        {snippet}
      </pre>
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(snippet)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? t("knowledge.embed.copied") : t("knowledge.embed.copy")}
      </Button>
      <p className="text-caption text-fg-muted">{t("knowledge.embed.origins")}</p>
    </div>
  );
}
