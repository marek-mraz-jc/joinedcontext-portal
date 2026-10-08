/**
 * A Policy as a sentence (T-3276): who may (or may not) do what, to which types and attributes,
 * in which space, narrowed by which filters, and from when until when. Built from the form's own
 * values, so the sentence and the YAML beside it always describe the same grant.
 */
import { groupOf } from "../../components/endpoints/operationGroups";
import type { PolicyForm } from "../../routes/PoliciesPage";

type T = (key: string, options?: Record<string, unknown>) => string;

/** `queryEntity` read as words: `query entity`; a group by the words its form choice uses. */
function operationWords(name: string, t: T): string {
  if (groupOf(name)) return t(`choice.operationGroup.${name}`).toLocaleLowerCase();
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLocaleLowerCase();
}

/** `a, b and c` in the person's language. */
function listed(items: string[], language: string): string {
  return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(items);
}

function day(value: string | undefined, language: string): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(at);
}

export function policySentence(policy: Partial<PolicyForm>, t: T, language: string): string {
  const assignee = policy.assignee ?? { kind: "role", id: "" };
  const who = assignee.id
    ? t(`policies.sentence.who.${assignee.kind}`, { id: assignee.id, defaultValue: `${assignee.kind} ${assignee.id}` })
    : t("policies.sentence.nobody");
  const operations = (policy.operations ?? []).map((name) => operationWords(name, t));
  const what = operations.length > 0 ? listed(operations, language) : t("policies.sentence.nothing");
  const types = [
    ...new Set((policy.information ?? []).flatMap((item) => (item.entities ?? []).map((entity) => entity.type).filter(Boolean))),
  ];
  const attributes = [
    ...new Set((policy.information ?? []).flatMap((item) => [...(item.propertyNames ?? []), ...(item.relationshipNames ?? [])])),
  ];
  const parts = [
    t(policy.effect === "prohibition" ? "policies.sentence.mayNot" : "policies.sentence.may", {
      who,
      what,
      types: types.length > 0 ? listed(types, language) : t("policies.sentence.everyType"),
      space: policy.contextSpaceRef || "—",
    }),
  ];
  if (attributes.length > 0) parts.push(t("policies.sentence.attributes", { attributes: listed(attributes, language) }));
  if (policy.q) parts.push(t("policies.sentence.q", { q: policy.q }));
  if (policy.scopeQ) parts.push(t("policies.sentence.scope", { scope: policy.scopeQ }));
  if (policy.geoQ) parts.push(t("policies.sentence.geo", { geo: policy.geoQ }));
  if (policy.temporalQ) parts.push(t("policies.sentence.temporal", { temporal: policy.temporalQ }));
  const from = day(policy.validity?.from, language);
  const to = day(policy.validity?.to, language);
  if (from && to) parts.push(t("policies.sentence.between", { from, to }));
  else if (from) parts.push(t("policies.sentence.from", { from }));
  else if (to) parts.push(t("policies.sentence.until", { to }));
  return `${parts.join(", ")}.`;
}
