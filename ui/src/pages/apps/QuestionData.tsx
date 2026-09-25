import type { JSX } from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, FileDropZone, Input } from "../../components/ui";

/** What a question asks the person to hand over besides choosing (T-2694, API/04 section 5). */
export interface QuestionInput {
  file?: { accept: string[]; maxBytes: number };
  url?: boolean;
}

/** The answer a file or an address is: the shapes the Portal checks before the run reads it. */
export type DataAnswer =
  | { file: { name: string; format: string; text: string } }
  | { url: string };

/** The event's `input`, or `undefined` when the question asks for nothing but a choice or words. */
export function inputOf(raw: unknown): QuestionInput | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const input = raw as { file?: { accept?: unknown; maxBytes?: unknown }; url?: unknown };
  const accept = Array.isArray(input.file?.accept)
    ? input.file.accept.filter((one): one is string => typeof one === "string")
    : [];
  const file =
    accept.length > 0 && typeof input.file?.maxBytes === "number"
      ? { accept, maxBytes: input.file.maxBytes }
      : undefined;
  const url = input.url === true;
  return file || url ? { file, url } : undefined;
}

/** The format a file's name says, lower case, or "" without an extension. */
function formatOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** An absolute http(s) address, which is all the Portal takes (API/04 section 5). */
function isFeedAddress(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "" && text.length <= 2048;
  } catch {
    return false;
  }
}

/**
 * A file dropped or a feed's address, as the answer to a question that asks for data (T-2694).
 * The browser refuses what the Portal would: a format the question does not take or a file over
 * its size is said here and nothing is sent; the Portal checks the same again.
 */
export function QuestionData({
  input,
  disabled,
  onAnswer,
}: {
  input: QuestionInput;
  disabled?: boolean;
  onAnswer: (answer: DataAnswer) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const urlId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const kilobytes = input.file ? Math.floor(input.file.maxBytes / 1024) : 0;

  const take = async (file: File): Promise<void> => {
    if (!input.file) {
      return;
    }
    const format = formatOf(file.name);
    if (!input.file.accept.includes(format)) {
      setProblem(t("agentRun.question.file.wrongType", { formats: input.file.accept.join(", ") }));
      return;
    }
    if (file.size === 0 || file.size > input.file.maxBytes) {
      setProblem(file.size === 0 ? t("agentRun.question.file.empty") : t("agentRun.question.file.tooLarge", { kilobytes }));
      return;
    }
    const text = await file.text();
    if (format === "json") {
      try {
        JSON.parse(text);
      } catch {
        setProblem(t("agentRun.question.file.notJson"));
        return;
      }
    }
    setProblem(null);
    onAnswer({ file: { name: file.name, format, text } });
  };

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="question-data">
      {input.file ? (
        <FileDropZone
          label={t("agentRun.question.file.label")}
          button={t("agentRun.question.file.button")}
          hint={t("agentRun.question.file.hint", { formats: input.file.accept.join(", "), kilobytes })}
          accept={input.file.accept.map((format) => `.${format}`).join(",")}
          onFiles={(files) => {
            if (!disabled && files[0]) {
              void take(files[0]);
            }
          }}
        >
          {problem ? (
            <p role="alert" className="text-caption text-danger">
              {problem}
            </p>
          ) : null}
        </FileDropZone>
      ) : null}
      {input.url ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = address.trim();
            if (!isFeedAddress(text)) {
              setAddressProblem(t("agentRun.question.url.invalid"));
              return;
            }
            setAddressProblem(null);
            onAnswer({ url: text });
          }}
        >
          <Field id={urlId} label={t("agentRun.question.url.label")} errors={addressProblem ? [addressProblem] : undefined}>
            <Input
              id={urlId}
              type="url"
              inputMode="url"
              placeholder="https://"
              value={address}
              disabled={disabled}
              onChange={(event) => {
                setAddress(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" size="sm" className="self-start" disabled={disabled || address.trim() === ""}>
            {t("agentRun.question.url.use")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
