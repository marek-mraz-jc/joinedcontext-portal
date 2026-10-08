import { useEffect, useMemo, useRef, useState } from "react";
import { format, isLanguageMap } from "@joinedcontext/sdk";
import type { Row } from "@joinedcontext/sdk";

export interface ArticleInput {
  id: string;
  title: string;
  summary?: string;
  published?: string;
}

export interface AnalysisInput {
  articles: ArticleInput[];
  k: number;
  seed: number;
}

export interface Keyword {
  term: string;
  weight: number;
}

export interface Topic {
  id: number;
  keywords: Keyword[];
  articles: string[];
  share: number;
}

export interface WeekShare {
  week: string;
  shares: number[];
}

export interface AnalysisOutput {
  topics: Topic[];
  weeks: WeekShare[];
  unassigned: string[];
}

export type TopicStatus = "loading" | "ready" | "error";

export interface TopicsHookResult {
  status: TopicStatus;
  result: AnalysisOutput | null;
  error: Error | null;
}

/** A cell as text: a language map the SDK left unresolved gives its English, else its first value. */
function textOf(cell: Row[string]): string {
  if (isLanguageMap(cell)) {
    const map = cell.languageMap as Record<string, unknown>;
    const chosen = map.en ?? Object.values(map)[0];
    return typeof chosen === "string" ? chosen.trim() : "";
  }
  return (format(cell) ?? "").trim();
}

/** Formats SDK rows into the typed input expected by the WASM topic clusterer; the module clamps k. */
export function toInput(rows: Row[], k = 5, seed = 1): AnalysisInput {
  const articles: ArticleInput[] = rows.map((row) => {
    const title = textOf(row.name) || row.id;
    const summary = textOf(row.description);
    const published = textOf(row.datePublished);
    const article: ArticleInput = {
      id: row.id,
      title,
    };
    if (summary) article.summary = summary;
    if (published) article.published = published;
    return article;
  });

  return { articles, k, seed };
}

/**
 * Runs topic clustering in a dedicated Web Worker, dropping stale requests
 * and managing loading and error states cleanly without crashing.
 */
export function useTopics(rows: Row[], k = 5, seed = 1): TopicsHookResult {
  const [status, setStatus] = useState<TopicStatus>("loading");
  const [result, setResult] = useState<AnalysisOutput | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const nextIdRef = useRef(1);
  const activeIdRef = useRef<number | null>(null);

  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    workerRef.current = worker;

    worker.onmessage = (
      event: MessageEvent<{ id: number; output?: AnalysisOutput | { error: string }; error?: string }>,
    ) => {
      const msg = event.data;
      if (!msg || msg.id !== activeIdRef.current) {
        return;
      }

      if (msg.error) {
        setStatus("error");
        setError(new Error(msg.error));
        setResult(null);
      } else if (msg.output) {
        if ("error" in msg.output && typeof msg.output.error === "string") {
          setStatus("error");
          setError(new Error(msg.output.error));
          setResult(null);
        } else {
          setStatus("ready");
          setResult(msg.output as AnalysisOutput);
          setError(null);
        }
      }
    };

    worker.onerror = (err) => {
      setStatus("error");
      setError(new Error(err.message || "Worker error"));
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const input = useMemo(() => toInput(rows, k, seed), [rows, k, seed]);
  const inputJson = useMemo(() => JSON.stringify(input), [input]);

  useEffect(() => {
    if (rows.length === 0) {
      setStatus("ready");
      setResult({ topics: [], weeks: [], unassigned: [] });
      setError(null);
      activeIdRef.current = null;
      return;
    }

    const worker = workerRef.current;
    if (!worker) {
      return;
    }

    const id = nextIdRef.current++;
    activeIdRef.current = id;
    setStatus("loading");

    worker.postMessage({ id, input });
  }, [inputJson, rows.length]);

  return { status, result, error };
}
