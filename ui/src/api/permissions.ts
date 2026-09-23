import { useQuery } from "@tanstack/react-query";
import { api, queryKeys, unwrap } from "./client";
import type { components } from "./schema";

/** What the caller may do in one project, from the bindings of the organization repository (PF-50). */
export type Effective = components["schemas"]["Effective"];
export type Verb = "propose" | "approve" | "delete";

export interface Rule {
  kinds?: string[];
  verbs?: string[];
}

/** A grant allows a verb on a kind when its rule names both; `*` matches any kind. */
export function allows(effective: Effective | undefined, kind: string, verb: Verb): boolean {
  // Not (yet) a permissions document: the control shows and the API decides (PF-51 says the
  // UI is never the point of enforcement). Only a document that lists no grant hides it.
  if (!effective || !Array.isArray(effective.grants) || effective.bootstrap === true) {
    return true;
  }
  return effective.grants.some((grant) => {
    const rule = grant.rule as Rule;
    return (kind === "*" || rule.kinds?.includes(kind)) && Boolean(rule.verbs?.includes(verb));
  });
}

/**
 * Whether a grant lets the caller read `kind` (PF-59): `read`, or `propose`, which implies it
 * (jc-core `Rule::grants`). `undefined` while no document has arrived: a page that must not
 * fetch a list for a caller who may not read it waits instead of guessing (T-2605).
 */
export function mayRead(effective: Effective | undefined, kind: string): boolean | undefined {
  if (!effective || !Array.isArray(effective.grants)) {
    return undefined;
  }
  if (effective.bootstrap === true) {
    return true;
  }
  return effective.grants.some((grant) => {
    const rule = grant.rule as Rule;
    return Boolean(rule.kinds?.includes(kind)) && Boolean(rule.verbs?.includes("read") || rule.verbs?.includes("propose"));
  });
}

/**
 * The caller's effective permissions in `project` (T-0526). A convenience for the UI: a
 * control renders only when the API would honour it, and the API decides on its own.
 */
export function usePermissions(project: string) {
  const query = useQuery({
    queryKey: queryKeys.permissions(project),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/permissions/me", {
          params: { path: { project } },
        }),
      ),
    enabled: project !== "",
    // A fresh Portal pod answers with no grant until its first mirror sync; a page opened in
    // that window would otherwise keep every control disabled until a reload (T-0630).
    refetchInterval: (query) => {
      const data = query.state.data;
      return data &&
        Array.isArray(data.grants) &&
        data.grants.length === 0 &&
        data.bootstrap !== true
        ? 5000
        : false;
    },
  });
  return {
    data: query.data,
    isLoading: query.isPending,
    can: (kind: string, verb: Verb) => allows(query.data, kind, verb),
  };
}

/** One rule of a `Role` as the form holds it: the verbs it grants on the kinds it names. */
export interface GrantedRule {
  kinds?: string[];
  verbs?: string[];
  constraints?: unknown[];
}

/**
 * What a proposed `Role` would grant beyond what the caller holds, as `verb on Kind` (PF-52).
 *
 * The same rule as `permissions::within_own_rights` on the server, read here so the form says it
 * before the proposal is sent: every verb on every kind a rule grants has to be one the caller
 * already holds, under no constraint their own grant adds. It never decides — an empty list means
 * "nothing this side can see is missing", and the API is still the refusal (PF-51).
 */
export function beyondOwnRights(
  effective: Effective | undefined,
  rules: GrantedRule[] | undefined,
): string[] {
  if (!effective || !Array.isArray(effective.grants) || effective.bootstrap === true) {
    return [];
  }
  const missing: string[] = [];
  for (const rule of rules ?? []) {
    const constraints = JSON.stringify(rule.constraints ?? []);
    for (const kind of rule.kinds ?? []) {
      for (const verb of rule.verbs ?? []) {
        const holds = effective.grants.some((grant) => {
          const held = grant.rule as GrantedRule;
          return (
            Boolean(held.kinds?.includes(kind)) &&
            Boolean(held.verbs?.includes(verb)) &&
            (held.constraints ?? []).every((constraint) =>
              constraints.includes(JSON.stringify(constraint)),
            )
          );
        });
        const item = `${verb} on ${kind}`;
        if (!holds && !missing.includes(item)) {
          missing.push(item);
        }
      }
    }
  }
  return missing;
}

/** The kinds and the verbs the caller may grant in `project`, for the lists a role form offers. */
export function ownRights(effective: Effective | undefined): { kinds: string[]; verbs: string[] } {
  if (!effective || !Array.isArray(effective.grants) || effective.bootstrap === true) {
    return { kinds: [], verbs: [] };
  }
  const kinds = new Set<string>();
  const verbs = new Set<string>();
  for (const grant of effective.grants) {
    const rule = grant.rule as GrantedRule;
    for (const kind of rule.kinds ?? []) kinds.add(kind);
    for (const verb of rule.verbs ?? []) verbs.add(verb);
  }
  return { kinds: [...kinds].sort(), verbs: [...verbs].sort() };
}
