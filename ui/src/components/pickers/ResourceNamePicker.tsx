import { useMemo } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { asManifests, localized } from "../../api/manifest";
import { Combobox } from "./Combobox";
import type { PickerOption } from "./Combobox";
import { reasonOf } from "./organizationModels";

export interface ResourceNamePickerProps {
  id?: string;
  label: string;
  /** Named by a `<label for={id}>` of the page (see `Combobox`). */
  labelled?: boolean;
  /** Whose manifests: a project's `{plural}`, or `"projects"` for the projects the caller reads. */
  from: { project: string; plural: string } | "projects";
  value: string;
  onChange: (name: string) => void;
  /** Offer the typed text as a new name, where the form creates what it names. */
  create?: boolean;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}

/**
 * A name of something that exists, picked from the list the server gives this caller (ADR-N-033,
 * T-2702): the list holds nothing they cannot read, so the picker offers nothing they could not open.
 */
export function ResourceNamePicker({
  id,
  label,
  labelled,
  from,
  value,
  onChange,
  create = false,
  disabled,
  required,
  invalid,
  describedBy,
  placeholder,
}: ResourceNamePickerProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const inProject = from === "projects" ? undefined : from;
  // The projects are asked for only by a picker of projects: the key is `useProjects`' own.
  const projects = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects")),
    select: (list) => list.items.map((item) => item.name),
    enabled: !inProject,
  });
  const manifests = useQuery({
    queryKey: queryKeys.list(inProject?.project ?? "", inProject?.plural ?? ""),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project: inProject?.project ?? "", plural: inProject?.plural ?? "" } },
        }),
      ),
    enabled: Boolean(inProject?.project && inProject.plural),
  });
  const query = inProject ? manifests : projects;

  const options = useMemo<PickerOption[]>(() => {
    if (!inProject) {
      return (projects.data ?? []).map((name) => ({ value: name, label: name, group: label }));
    }
    return asManifests(manifests.data?.items ?? []).map((manifest) => {
      const title = localized(manifest.metadata.title, i18n.language, manifest.metadata.name);
      return {
        value: manifest.metadata.name,
        label: title,
        detail: title === manifest.metadata.name ? undefined : manifest.metadata.name,
        group: label,
      };
    });
  }, [inProject, projects.data, manifests.data, i18n.language, label]);

  return (
    <Combobox
      id={id}
      label={label}
      labelled={labelled}
      value={value ? [value] : []}
      options={options}
      disabled={disabled}
      required={required}
      invalid={invalid}
      describedBy={describedBy}
      placeholder={placeholder}
      loading={query.isLoading}
      failed={query.isError ? { reason: reasonOf(query.error), retry: () => void query.refetch() } : undefined}
      empty={t("form.noResults")}
      onChange={(values) => {
        onChange(values[0] ?? "");
      }}
      create={create ? { label: (name) => t("picker.createNamed", { name }), onCreate: onChange } : undefined}
    />
  );
}
