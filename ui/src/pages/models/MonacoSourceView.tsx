/**
 * The Monaco editor itself, loaded only when the source view is opened.
 *
 * Monaco is a few megabytes and reaches for browser APIs at import time, so it is not part of
 * the Portal's main bundle and not something every other view has to carry: this module is
 * imported lazily, and everything that can be decided without an editor lives in
 * `LinkmlSourceEditor` instead.
 */
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import "./monaco-setup";

export interface MonacoSourceViewProps {
  value: string;
  onChange: (value: string) => void;
  onMount: OnMount;
  height: string;
}

const DARK = "(prefers-color-scheme: dark)";

/**
 * Monaco paints with its own colours, not the Portal's tokens (UI-30).
 *
 * It is a canvas: it parses hex strings itself, so `bg-surface` never reaches it and the theme
 * has to be chosen by name. `vs` was hard-coded, which left a white editor — white gutter, white
 * minimap margin, black text — in the middle of a dark page for anyone whose system asks for
 * dark. The two built-in themes are picked from the same media query `tokens.css` flips on, so
 * the editor turns with the rest of the page, including when the system changes while it is open.
 */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(watchTheme, isDark, () => false);
}

/** The media query, or nothing where there is no browser to ask (a server render, a test). */
function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK)
    : null;
}

function isDark(): boolean {
  return mediaQuery()?.matches ?? false;
}

function watchTheme(onChange: () => void): () => void {
  const media = mediaQuery();
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

export default function MonacoSourceView({
  value,
  onChange,
  onMount,
  height,
}: MonacoSourceViewProps): JSX.Element {
  const dark = useDarkTheme();
  return (
    <Editor
      height={height}
      language="yaml"
      theme={dark ? "vs-dark" : "vs"}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={onMount}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
        renderWhitespace: "boundary",
      }}
    />
  );
}
