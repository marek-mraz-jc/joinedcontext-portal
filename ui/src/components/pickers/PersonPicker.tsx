import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { mayRead, usePermissions } from "../../api/permissions";
import { ORG_NAMESPACE } from "../../api/manifest";
import { asUser } from "../../pages/apps/members";
import { Combobox } from "./Combobox";
import type { PickerOption } from "./Combobox";
import { reasonOf, useDebounced } from "./organizationModels";

export interface PersonPickerProps {
  id?: string;
  label: string;
  /** Named by a `<label for={id}>` of the page (see `Combobox`). */
  labelled?: boolean;
  /** The chosen person's e-mail, lower case. */
  value: string;
  onChange: (email: string) => void;
  /** E-mails already taken (a group's members): not offered again. */
  exclude?: string[];
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** What a surrounding `Field` hands its control: its hint and error ids. */
  "aria-describedby"?: string;
}

/**
 * A person of the organization, picked from the realm's people the server lists to this caller
 * (GET /organization/people, Person read), searched on the server as they type (T-4947). A person
 * who has not signed in yet is not in that list: a well-formed e-mail is offered as such, never
 * any other text. The door still decides: a binding or group naming nobody grants nobody.
 */
export function PersonPicker({
  id,
  label,
  labelled,
  value,
  onChange,
  exclude = [],
  disabled,
  required,
  invalid,
  describedBy,
  "aria-describedby": fieldDescribedBy,
}: PersonPickerProps): JSX.Element {
  const { t } = useTranslation();
  const permissions = usePermissions(ORG_NAMESPACE);
  const reads = mayRead(permissions.data, "Person") === true;
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed.trim());
  const people = useQuery({
    queryKey: queryKeys.peoplePage(search, 0),
    enabled: reads,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/organization/people", { params: { query: { max: 100, ...(search ? { search } : {}) } } })),
  });
  const options = useMemo<PickerOption[]>(() => {
    const taken = new Set(exclude.map((email) => email.toLowerCase()));
    return (people.data?.items ?? [])
      .filter((person) => person.enabled && !taken.has(person.email.toLowerCase()))
      .map((person) => {
        const name = `${person.firstName} ${person.lastName}`.trim();
        return {
          value: person.email.toLowerCase(),
          label: name || person.email,
          detail: name ? person.email : undefined,
          group: t("picker.person.group"),
        };
      });
  }, [people.data, exclude, t]);
  // The chosen e-mail stays visible as a pill even when the current search does not list it.
  const shown = value && !options.some((option) => option.value === value)
    ? [...options, { value, label: value, group: t("picker.person.typed") }]
    : options;
  return (
    <Combobox
      id={id}
      label={label}
      labelled={labelled}
      value={value ? [value] : []}
      options={shown}
      disabled={disabled}
      required={required}
      invalid={invalid}
      describedBy={describedBy ?? fieldDescribedBy}
      placeholder="firstname.lastname@example.org"
      loading={reads && people.isLoading}
      failed={people.isError ? { reason: reasonOf(people.error), retry: () => void people.refetch() } : undefined}
      empty={reads ? t("picker.person.none") : t("picker.person.unlisted")}
      onSearch={setTyped}
      onChange={(values) => onChange(values[0] ?? "")}
      create={{
        label: (text) => (asUser(text) ? t("picker.person.invite", { email: asUser(text) }) : t("picker.person.needEmail")),
        onCreate: (text) => {
          const email = asUser(text);
          if (email) onChange(email);
        },
      }}
    />
  );
}
