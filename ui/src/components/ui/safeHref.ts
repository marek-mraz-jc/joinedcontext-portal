/**
 * PF-50: the schemes a link may carry. A URL reaches the Portal from a manifest, a status field
 * or a catalogue answer, so `href` is data, and `javascript:` in an `href` runs on click with the
 * page's own origin. Only what can navigate is allowed through.
 */
const SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** A host no address of this page can name: what a relative path resolves against. */
const BASE = "https://portal.invalid";

/**
 * `path` when it is a path on this origin, `undefined` when it is not. A browser reads `/\\host`
 * and `/<tab>/host` as `//host`, another origin (F-UI1-001, F-UI3-007), so the path is resolved
 * the way the browser resolves it and kept only when it stays on the base.
 */
export function sameOriginPath(path: string): string | undefined {
  if (!/^[./?#]/.test(path)) return undefined;
  try {
    return new URL(path, `${BASE}/`).origin === BASE ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `href` when it is safe to put in a link, `undefined` when it is not (PF-50).
 *
 * Relative paths and fragments pass: they stay on this origin. An absolute URL passes only with
 * `http`, `https` or `mailto`. Everything else — `javascript:`, `data:`, `vbscript:`, a scheme
 * with a tab or a newline inside it — comes back `undefined`, and the caller renders the text
 * without a link rather than a link that does something else.
 */
export function safeHref(href: string | undefined | null): string | undefined {
  if (typeof href !== "string") return undefined;
  const trimmed = href.trim();
  if (trimmed === "") return undefined;
  // A relative path, a query or a fragment: no scheme, no authority, nothing to mistake.
  if (/^[./?#\\]/.test(trimmed)) return sameOriginPath(trimmed);
  try {
    // `URL` resolves the escapes and the control characters a hand-written check misses:
    // `java\tscript:alert(1)` parses as the `javascript:` it is.
    const parsed = new URL(trimmed, BASE);
    if (!SCHEMES.has(parsed.protocol)) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}
