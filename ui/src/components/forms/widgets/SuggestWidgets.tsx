import { useContext, useId } from "react";
import type { ChangeEvent, FocusEvent, JSX } from "react";
import { ariaDescribedByIds } from "@rjsf/utils";
import type { WidgetProps } from "@rjsf/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../../api/client";
import { asManifests, ORG_NAMESPACE } from "../../../api/manifest";
import type { Manifest } from "../../../api/manifest";
import { filterSlotsOf } from "../../entities/filters";
import { Input } from "../../ui";
import { useShownErrors } from "../touched";
import { FormDataContext } from "./EntitySelectorField";
import { FormProjectContext } from "./ModelWidgets";

/** A free-text field with the choices that exist offered under it, as the browser lists them. */
function Suggested(props: WidgetProps & { choices: string[]; note?: string }): JSX.Element {
  const { id, value, required, disabled, readonly, onChange, onBlur, onFocus, rawErrors, placeholder, choices, note } = props;
  const listId = useId();
  const errors = useShownErrors(id, rawErrors);
  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        list={choices.length > 0 ? listId : undefined}
        value={typeof value === "string" ? value : ""}
        required={required}
        disabled={disabled || readonly}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={ariaDescribedByIds(id)}
        aria-invalid={errors && errors.length > 0 ? "true" : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value === "" ? undefined : event.target.value)}
        onBlur={(event: FocusEvent<HTMLInputElement>) => onBlur?.(id, event.target.value)}
        onFocus={(event: FocusEvent<HTMLInputElement>) => onFocus?.(id, event.target.value)}
      />
      {choices.length > 0 ? (
        <datalist id={listId}>
          {choices.map((choice) => (
            <option key={choice} value={choice} />
          ))}
        </datalist>
      ) : null}
      {note ? <p className="text-caption text-fg-muted">{note}</p> : null}
    </div>
  );
}

function names(items: unknown): string[] {
  return asManifests((items as { items?: Manifest[] } | undefined)?.items ?? []).map((m) => m.metadata.name);
}

/** Where each kind of grantee is listed, and whether the list is the project's or the organization's. */
const LISTS: Record<string, { plural: string; scopes: ("project" | "org")[] }> = {
  role: { plural: "roles", scopes: ["project", "org"] },
  group: { plural: "groups", scopes: ["org"] },
  serviceAccount: { plural: "serviceaccounts", scopes: ["project"] },
};

/**
 * Who a policy is granted to, by `assignee.kind` (T-3217): the roles, groups and service
 * accounts the person may read are offered by name, and the people when they may list them. A
 * DID, or a person outside the list, is still typed; the lists come narrowed to what the caller
 * may read, so nobody is offered a name they could not open.
 */
export function AssigneePicker(props: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const project = useContext(FormProjectContext) ?? "";
  const root = useContext(FormDataContext) as { assignee?: { kind?: unknown } } | undefined;
  const kind = typeof root?.assignee?.kind === "string" ? root.assignee.kind : "role";
  const list = LISTS[kind];
  const lists = useQueries({
    queries: (list?.scopes ?? []).map((scope) => {
      const owner = scope === "org" ? ORG_NAMESPACE : project;
      return {
        queryKey: queryKeys.list(owner, list?.plural ?? ""),
        queryFn: async () =>
          unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project: owner, plural: list?.plural ?? "" } } })),
        enabled: Boolean(owner && list),
        retry: false,
      };
    }),
  });
  const people = useQuery({
    queryKey: ["organization", "people", "names"],
    queryFn: async () => unwrap(await api.GET("/api/v1/organization/people", { params: { query: { max: 100 } } })),
    enabled: kind === "user",
    retry: false,
  });
  const choices =
    kind === "user"
      ? ((people.data as { items?: { email?: string | null; username?: string }[] } | undefined)?.items ?? [])
          .map((person) => person.email ?? person.username ?? "")
          .filter(Boolean)
      : [...new Set(lists.flatMap((query) => names(query.data)))].sort();
  const note =
    kind === "did"
      ? t("policies.assignee.didHint")
      : kind === "user" && people.isError
        ? t("policies.assignee.peopleHidden")
        : choices.length === 0 && lists.every((query) => !query.isPending)
          ? t("policies.assignee.noneYet", { kind: t(`choice.principalKind.${kind}`, { defaultValue: kind }) })
          : undefined;
  return <Suggested {...props} choices={choices} note={note} />;
}

/**
 * An attribute name of the entity types the policy covers, from the project's models (T-3217):
 * the names a person would otherwise have to know. `ui:options.kind` keeps a property field to
 * properties and a relationship field to relationships; a name no model holds is still typed.
 */
export function AttributeSuggest(props: WidgetProps): JSX.Element {
  const kind = props.options?.kind === "Relationship" ? "Relationship" : "Property";
  const project = useContext(FormProjectContext) ?? "";
  const root = useContext(FormDataContext) as
    | { information?: { entities?: { type?: unknown }[] }[] }
    | undefined;
  const types = [
    ...new Set(
      (root?.information ?? [])
        .flatMap((item) => item?.entities ?? [])
        .map((entity) => entity?.type)
        .filter((type): type is string => typeof type === "string" && type !== ""),
    ),
  ];
  const models = useQuery({
    queryKey: queryKeys.list(project, "datamodels"),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project, plural: "datamodels" } } })),
    enabled: Boolean(project) && types.length > 0,
  });
  const choices = [
    ...new Set(
      asManifests(models.data?.items ?? []).flatMap((model) =>
        types.flatMap((type) => filterSlotsOf(model, type).filter((slot) => slot.kind === kind).map((slot) => slot.name)),
      ),
    ),
  ].sort();
  return <Suggested {...props} choices={choices} />;
}
