import { useId, useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { isChange, storedMetadata } from "../../api/manifest";
import type { Change } from "../../api/manifest";
import { proposeChecked } from "../../api/proposal";
import { ChangeNotice } from "../../components/ChangeNotice";
import { Alert, Button, Field, Input, Select } from "../../components/ui";
import { PermissionGuard } from "../../components/ui/PermissionGuard";
import { useGroups } from "../access/Groups";

/** Who holds a role: one person by e-mail or one group of the organization (AP-91). */
export interface Subject {
  user?: string;
  group?: string;
}

interface AppRole {
  name: string;
  title?: string | Record<string, string>;
  description?: string;
}

interface AppAccess {
  role: string;
  subjects: Subject[];
}

/** The part of an App's spec this section reads and writes; the rest travels on untouched. */
export interface RolesSpec {
  roles?: AppRole[];
  access?: AppAccess[];
  [rest: string]: unknown;
}

const same = (a: Subject, b: Subject) => (a.user ?? null) === (b.user ?? null) && (a.group ?? null) === (b.group ?? null);

/** The members of `role`, in the order the manifest lists them. */
export function membersOf(spec: RolesSpec, role: string): Subject[] {
  return (spec.access ?? []).filter((entry) => entry.role === role).flatMap((entry) => entry.subjects);
}

/** The spec with `subject` added to `role`, or `null` when it already holds it. */
export function withMember(spec: RolesSpec, role: string, subject: Subject): RolesSpec | null {
  if (membersOf(spec, role).some((held) => same(held, subject))) return null;
  const access = spec.access ?? [];
  const listed = access.some((entry) => entry.role === role);
  return {
    ...spec,
    access: listed
      ? access.map((entry) => (entry.role === role ? { ...entry, subjects: [...entry.subjects, subject] } : entry))
      : [...access, { role, subjects: [subject] }],
  };
}

/**
 * The spec with `subject` taken out of `role`. A role left with nobody loses its `access` entry,
 * since jc-core refuses an entry without subjects (AP-91); the role itself stays declared.
 */
export function withoutMember(spec: RolesSpec, role: string, subject: Subject): RolesSpec {
  return {
    ...spec,
    access: (spec.access ?? [])
      .map((entry) =>
        entry.role === role ? { ...entry, subjects: entry.subjects.filter((held) => !same(held, subject)) } : entry,
      )
      .filter((entry) => entry.subjects.length > 0),
  };
}

/** A person is named by the e-mail the realm signs them in with, lower case (AP-91). */
export function asUser(typed: string): string | null {
  const email = typed.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function titleOf(role: AppRole, language: string): string {
  if (typeof role.title === "string") return role.title;
  return role.title?.[language] ?? role.title?.en ?? role.name;
}

/**
 * Who holds which role of an application (AP-99, ADR-N-027): each role with its description and
 * its members, users and groups, with Add member and Remove. Each proposes the App manifest with
 * the new `spec.access` through the one propose function, checked first like every proposal
 * (PF-57), and leaves a change to review; nothing here grants anything by itself. A person without
 * `propose` on `App` sees every write control disabled with the reason (PF-50, UI-44).
 *
 * An App that declares no role shows nothing: there is nobody to add to anything.
 */
export function RolesAndMembers({ project, name }: { project: string; name: string }): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const heading = useId();
  const queryClient = useQueryClient();
  const [change, setChange] = useState<Change | null>(null);
  const [error, setError] = useState<string | null>(null);
  const app = useQuery({
    queryKey: queryKeys.resource(project, "apps", name),
    queryFn: async () =>
      unwrap<unknown>(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project, plural: "apps", name } },
        }),
      ),
    retry: false,
  });
  const propose = useMutation({
    mutationFn: (spec: RolesSpec) =>
      proposeChecked(
        project,
        "apps",
        {
          apiVersion: "joinedcontext.com/v1alpha1",
          kind: "App",
          metadata: { ...storedMetadata(app.data), name, namespace: project },
          spec,
        },
        false,
      ),
    onMutate: () => {
      setError(null);
      setChange(null);
    },
    onSuccess: (result) => {
      if (isChange(result)) setChange(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.resource(project, "apps", name) });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? (err.problem?.detail ?? err.message) : t("app.error.generic"));
    },
  });

  const spec = ((app.data as { spec?: RolesSpec } | undefined)?.spec ?? {}) as RolesSpec;
  const roles = spec.roles ?? [];
  if (roles.length === 0) return null;

  return (
    <section aria-labelledby={heading} className="space-y-3 rounded border border-border p-4">
      <h2 id={heading} className="text-lg font-semibold">
        {t("apps.roles.title")}
      </h2>
      <p className="text-sm text-fg-muted">{t("apps.roles.lead")}</p>
      {change && <ChangeNotice change={change} project={project} />}
      {error && (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      )}
      <ul className="space-y-4">
        {roles.map((role) => (
          <RoleRow
            key={role.name}
            project={project}
            role={role}
            title={titleOf(role, i18n.language)}
            members={membersOf(spec, role.name)}
            busy={propose.isPending}
            onAdd={(subject) => {
              const next = withMember(spec, role.name, subject);
              if (next) propose.mutate(next);
            }}
            onRemove={(subject) => propose.mutate(withoutMember(spec, role.name, subject))}
          />
        ))}
      </ul>
    </section>
  );
}

function RoleRow({
  project,
  role,
  title,
  members,
  busy,
  onAdd,
  onRemove,
}: {
  project: string;
  role: AppRole;
  title: string;
  members: Subject[];
  busy: boolean;
  onAdd: (subject: Subject) => void;
  onRemove: (subject: Subject) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const groups = useGroups();
  const [kind, setKind] = useState<"user" | "group">("user");
  const [typed, setTyped] = useState("");
  const ids = useId();
  const groupNames = ((groups.data?.items ?? []) as { metadata: { name: string } }[]).map((g) => g.metadata.name);
  const user = asUser(typed);
  const subject: Subject | null = kind === "user" ? (user ? { user } : null) : typed ? { group: typed } : null;
  const held = subject !== null && members.some((m) => same(m, subject));
  const reason =
    subject === null
      ? kind === "user"
        ? t("apps.roles.needEmail")
        : t("apps.roles.needGroup")
      : held
        ? t("apps.roles.already")
        : undefined;

  return (
    <li className="space-y-2" aria-label={title}>
      <div>
        <h3 className="font-medium">
          {title} <span className="text-sm text-fg-muted">({t("apps.roles.count", { count: members.length })})</span>
        </h3>
        {role.description && <p className="text-sm text-fg-muted">{role.description}</p>}
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("apps.roles.nobody")}</p>
      ) : (
        <ul className="space-y-1">
          {members.map((member) => {
            const label = member.user ?? t("apps.roles.groupMember", { group: member.group });
            return (
              <li key={member.user ?? `group:${member.group}`} className="flex items-center gap-2">
                <span>{label}</span>
                <PermissionGuard project={project} kind="App" verb="propose">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={t("apps.roles.removeLabel", { member: label, role: title })}
                    onClick={() => onRemove(member)}
                  >
                    {t("apps.roles.remove")}
                  </Button>
                </PermissionGuard>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (subject && !held) {
            onAdd(subject);
            setTyped("");
          }
        }}
      >
        <Field id={`${ids}-kind`} label={t("apps.roles.kind")}>
          <Select
            id={`${ids}-kind`}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "user" | "group");
              setTyped("");
            }}
          >
            <option value="user">{t("apps.roles.kindUser")}</option>
            <option value="group">{t("apps.roles.kindGroup")}</option>
          </Select>
        </Field>
        {kind === "user" ? (
          <Field id={`${ids}-who`} label={t("apps.roles.email")}>
            <Input
              id={`${ids}-who`}
              type="email"
              autoComplete="off"
              value={typed}
              placeholder="firstname.lastname@example.org"
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        ) : (
          <Field id={`${ids}-who`} label={t("apps.roles.group")}>
            <Select id={`${ids}-who`} value={typed} onChange={(event) => setTyped(event.target.value)}>
              <option value="">{t("apps.roles.pickGroup")}</option>
              {groupNames.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <PermissionGuard project={project} kind="App" verb="propose">
          <Button type="submit" size="sm" disabled={busy || reason !== undefined} disabledReason={reason}>
            {t("apps.roles.add")}
          </Button>
        </PermissionGuard>
      </form>
    </li>
  );
}
