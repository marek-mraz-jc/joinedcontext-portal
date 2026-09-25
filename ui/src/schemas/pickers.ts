/**
 * Every form field that names an existing resource is a picker (ADR-N-033, T-2702): this table is
 * the one place that says which picker, per kind and field path (`a.b[].c`, as the uischema
 * manifests write paths). `SchemaForm` applies it for the kind it edits, so a page cannot forget a
 * field, and `tests/reference_pickers.test.ts` fails when a kind's schema grows a reference field
 * that neither this table nor `UNPICKED` names.
 *
 * A field whose schema already offers its choices (`enum`, `oneOf`, because the page passed the
 * list) keeps that select: the page's list is the narrower one.
 */
import type { UiSchema } from "../components/forms/types";

type Entry = Record<string, unknown>;

/** An entity type from the space's model and its imports, or the project's models without a space. */
const TYPE: Entry = { "ui:widget": "typePicker", "ui:options": { spaceField: "contextSpaceRef" } };
const MODEL: Entry = { "ui:widget": "dataModelPicker" };
const project = (plural: string): Entry => ({ "ui:widget": "resourcePicker", "ui:options": { plural } });

export const REFERENCE_PICKERS: Record<string, Record<string, Entry>> = {
  ContextSpace: { dataModelRef: MODEL },
  Endpoint: {
    contextSpaceRef: project("spaces"),
    "publish.ckan.instanceRef": project("ckaninstances"),
    "catalog.pipelineRef": project("pipelines"),
  },
  DataModel: { contextSpaceRef: project("spaces") },
  Pipeline: {
    "source.dataSourceRef": project("datasources"),
    "source.endpointRef": project("endpoints"),
    "source.query.type": TYPE,
    "source.trigger.subscription.type": TYPE,
    "compute.mappingRef": project("mappings"),
    "output.type": TYPE,
  },
  Dashboard: {
    "pages[].widgets[].endpointRef": project("endpoints"),
    "pages[].widgets[].entityType": TYPE,
  },
  Layer: { sourceEndpointRef: project("endpoints"), entityType: TYPE },
  Policy: { contextSpaceRef: project("spaces"), "information[].entities[].type": TYPE },
  Subscription: { contextSpaceRef: project("spaces"), "entities[].type": TYPE },
  ContextSourceRegistration: {
    contextSpaceRef: project("spaces"),
    endpointRef: project("endpoints"),
    "federation.serviceAccountRef": project("serviceaccounts"),
    "information[].entities[].type": TYPE,
  },
  ServiceAccount: { "roles[].types[]": TYPE },
  App: { "dataNeeds[].contextSpaceRef": project("spaces"), "dataNeeds[].types[]": TYPE },
  Mapping: { contextSpaceRef: project("spaces"), "source.name": MODEL, "target.name": MODEL },
};

/**
 * Reference fields that stay as they are, each with the reason. A person is not a manifest and
 * has no list to pick from until the People page's route exists (T-2684).
 */
export const UNPICKED: Record<string, Record<string, string>> = {
  Policy: { "assignee.id": "names a role, group, person or service account by assignee.kind; the person list is T-2684" },
  Group: { "members[].user": "a person: the People list is T-2684" },
  ServiceAccount: {
    "owner.user": "a person: the People list is T-2684",
    "roles[].scope.name": "a space or a project by roles[].scope.level; the page lists both as suggestions",
    "roles[].role": "an organization or a project role: the page offers both lists as one choice once they load",
  },
  Role: { "rules[].kinds[]": "a manifest kind, a fixed vocabulary the page offers from the author's own rights (PF-68)" },
  Organization: { "projects.creation": "anyone, org-admin or group:<name>: a rule, validated by its pattern" },
  SyncSource: { "platformApi.project": "a project on another platform, which this one cannot list" },
};

function nodeAt(schema: unknown, path: string): Record<string, unknown> | undefined {
  let node = schema as Record<string, unknown> | undefined;
  for (const step of path.split(".")) {
    const array = step.endsWith("[]");
    const name = array ? step.slice(0, -2) : step;
    node = (node?.properties as Record<string, Record<string, unknown>> | undefined)?.[name];
    if (array) {
      node = node?.items as Record<string, unknown> | undefined;
    }
  }
  return node;
}

function place(uiSchema: Record<string, unknown>, path: string, entry: Entry): void {
  const steps = path.split(".").flatMap((step) => (step.endsWith("[]") ? [step.slice(0, -2), "items"] : [step]));
  let node = uiSchema;
  for (const step of steps) {
    const next = node[step];
    node[step] = next && typeof next === "object" ? { ...(next as Record<string, unknown>) } : {};
    node = node[step] as Record<string, unknown>;
  }
  if (node["ui:widget"] === undefined && node["ui:field"] === undefined) {
    Object.assign(node, entry);
  }
}

/** The kind's pickers laid under the form's own uiSchema; what the form sets itself wins. */
export function withPickers(kind: string | undefined, schema: unknown, uiSchema: UiSchema | undefined): UiSchema | undefined {
  const pickers = kind === undefined ? undefined : REFERENCE_PICKERS[kind];
  if (!pickers || Object.keys(pickers).length === 0) {
    return uiSchema;
  }
  // `place` copies every node on a path it writes, so the caller's uiSchema is never changed.
  const out: Record<string, unknown> = { ...(uiSchema ?? {}) };
  for (const [path, entry] of Object.entries(pickers)) {
    const field = nodeAt(schema, path);
    if (!field || field.enum !== undefined || field.oneOf !== undefined) {
      continue;
    }
    place(out, path, entry);
  }
  return out as UiSchema;
}
