import { useCallback } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";

/**
 * One choice of a page kept in the address's query (UI-89, T-3239): a tab, a view. A new choice
 * is a new history entry, so back and forward walk the choices and a reload or a copied link
 * opens the same one. The default is no parameter at all, and a value the page does not know
 * reads as the default. The rest of the query, the language override included, is kept.
 */
export function useUrlParam<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (next: T) => void] {
  const router = useRouter();
  const raw = useRouterState({ select: (state) => new URLSearchParams(state.location.searchStr).get(key) });
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => {
      const { pathname, search, hash } = router.history.location;
      const query = new URLSearchParams(search);
      if (next === fallback) query.delete(key);
      else query.set(key, next);
      const rest = query.toString();
      router.history.push(`${pathname}${rest ? `?${rest}` : ""}${hash}`);
    },
    [router, key, fallback],
  );
  return [value, set];
}

/** The longest entity id the address carries; NGSI-LD names no limit, a URL does. */
const MAX_URN = 1024;

/**
 * One entity named in the address's query (`?row=<urn>`, T-4828), so a link opens that row. Only an
 * NGSI-LD URN up to 1024 characters is read; anything else reads as none. Opening is a new history
 * entry, so back closes it; `null` removes the parameter.
 */
export function useUrlUrn(key: string): [string | null, (next: string | null) => void] {
  const router = useRouter();
  const raw = useRouterState({ select: (state) => new URLSearchParams(state.location.searchStr).get(key) });
  const value = raw !== null && raw.startsWith("urn:") && raw.length <= MAX_URN ? raw : null;
  const set = useCallback(
    (next: string | null) => {
      const { pathname, search, hash } = router.history.location;
      const query = new URLSearchParams(search);
      if ((query.get(key) ?? null) === next) return;
      if (next === null) query.delete(key);
      else query.set(key, next);
      const rest = query.toString();
      router.history.push(`${pathname}${rest ? `?${rest}` : ""}${hash}`);
    },
    [router, key],
  );
  return [value, set];
}
