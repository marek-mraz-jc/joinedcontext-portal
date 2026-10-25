import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { mayRead, usePermissions } from "../../api/permissions";
import { ORG_NAMESPACE } from "../../api/manifest";
import { asUser, emailsIn } from "../../pages/apps/members";
import { Combobox } from "./Combobox";
import type { PickerOption } from "./Combobox";
import { reasonOf, useDebounced } from "./organizationModels";

interface PersonPickerBase {
  id?: string;
  label: string;
  /** Named by a `<label for={id}>` of the page (see `Combobox`). */
  labelled?: boolean;
  /** E-mails already taken (a group's members): not offered again. */
  exclude?: string[];
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** What a surrounding `Field` hands its control: its hint and error ids. */
  "aria-describedby"?: string;
}

export type PersonPickerProps = PersonPickerBase &
  (
    | {
        multiple?: false;
        /** The chosen person's e-mail, lower case. */
        value: string;
        onChange: (email: string) => void;
      }
    | {
        /** Several people at once; a pasted list of e-mails adds each one (T-5605). */
        multiple: true;
        value: string[];
        onChange: (emails: string[]) => void;
        /** The words of a pasted list that are not e-mails, as typed: the page names them. */
        onRefused: (words: string[]) => void;
      }
  );

/**
 * A person of the organization, picked from the realm's people the server lists to this caller
 * (GET /organization/people, Person read), searched on the server as they type (T-4947). A person
 * who has not signed in yet is not in that list: a well-formed e-mail is offered as such, never
 * any other text. The door still decides: a binding or group naming nobody grants nobody.
 */
export function PersonPicker(props: PersonPickerProps): JSX.Element {
  const {
    id,
    label,
    labelled,
    exclude = [],
    disabled,
    required,
    invalid,
    describedBy,
    "aria-describedby": fieldDescribedBy,
  } = props;
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
  const chosen = props.multiple ? props.value : props.value ? [props.value] : [];
  // A chosen e-mail stays visible as a pill even when the current search does not list it.
  const shown = [
    ...options,
    ...chosen
      .filter((email) => !options.some((option) => option.value === email))
      .map((email) => ({ value: email, label: email, group: t("picker.person.typed") })),
  ];
  const choose = (emails: string[]) => (props.multiple ? props.onChange(emails) : props.onChange(emails[0] ?? ""));
  // One e-mail names one person; a pasted list adds each new e-mail and names the rest.
  const create = (text: string) => {
    if (!props.multiple) {
      const email = asUser(text);
      if (email) props.onChange(email);
      return;
    }
    const { emails, invalid: refused } = emailsIn(text);
    const taken = new Set([...exclude.map((email) => email.toLowerCase()), ...props.value]);
    props.onChange([...props.value, ...emails.filter((email) => !taken.has(email))]);
    props.onRefused(refused);
  };
  const createLabel = (text: string) => {
    const { emails, invalid: refused } = emailsIn(text);
    if (props.multiple && emails.length + refused.length > 1) return t("picker.person.addList", { count: emails.length });
    return asUser(text) ? t("picker.person.invite", { email: asUser(text) }) : t("picker.person.needEmail");
  };
  return (
    <Combobox
      id={id}
      label={label}
      labelled={labelled}
      value={chosen}
      options={shown}
      multiple={props.multiple}
      disabled={disabled}
      required={required}
      invalid={invalid}
      describedBy={describedBy ?? fieldDescribedBy}
      placeholder="firstname.lastname@example.org"
      loading={reads && people.isLoading}
      failed={people.isError ? { reason: reasonOf(people.error), retry: () => void people.refetch() } : undefined}
      empty={reads ? t("picker.person.none") : t("picker.person.unlisted")}
      onSearch={setTyped}
      onChange={choose}
      create={{ label: createLabel, onCreate: create }}
    />
  );
}
