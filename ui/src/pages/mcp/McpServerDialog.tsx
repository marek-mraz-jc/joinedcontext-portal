import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useProposal } from "../../api/proposal";
import type { Change, Manifest } from "../../api/manifest";
import { ChangeNotice } from "../../components/ChangeNotice";
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "../../components/ui";
import { ToolPreview } from "./McpServerPanels";
import { AUDIENCES, MAX_MEMBERS, breadth, emptyForm, formProblems, fromManifest, memberKey, toManifest, widestAllowed } from "./mcp";
import type { Audience, McpServerForm, MemberChoice } from "./mcp";

/**
 * Creates or edits one named MCP server (MF-53, T-3156): its members picked from the Endpoints
 * the person may read, its audience no wider than the narrowest member, the merged tool list
 * shown before anything is proposed, and the manifest proposed as a checked Change.
 */
export function McpServerDialog({
  project,
  stored,
  choices,
  choicesLoading,
  open,
  onOpenChange,
}: {
  project: string;
  /** The server being edited; none creates one. */
  stored?: Manifest;
  /** Every Endpoint the person may read, across the projects they see. */
  choices: MemberChoice[];
  choicesLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<McpServerForm>(() => (stored ? fromManifest(project, stored) : emptyForm()));
  const [search, setSearch] = useState("");
  const [tried, setTried] = useState(false);
  const [change, setChange] = useState<Change | null>(null);
  const proposal = useProposal(project, "mcpservers", setChange);

  const byKey = useMemo(() => new Map(choices.map((choice) => [memberKey(choice), choice])), [choices]);
  const picked = form.members.map((key) => byKey.get(key)).filter((choice): choice is MemberChoice => Boolean(choice));
  // A stored member this person cannot read stays in the manifest, unseen and unchanged (SP-20).
  const unseen = form.members.filter((key) => !byKey.has(key));
  const problems = formProblems(form, picked);
  const widest = widestAllowed(picked);
  const needle = search.trim().toLowerCase();
  const shown = choices.filter(
    (choice) => !needle || memberKey(choice).toLowerCase().includes(needle) || choice.title.toLowerCase().includes(needle),
  );

  const set = (patch: Partial<McpServerForm>) => setForm((current) => ({ ...current, ...patch }));
  const toggle = (key: string, on: boolean) =>
    set({ members: on ? [...form.members, key] : form.members.filter((member) => member !== key) });
  const close = (next: boolean) => {
    if (!next) {
      setChange(null);
      setTried(false);
      proposal.reset();
      if (!stored) setForm(emptyForm());
    }
    onOpenChange(next);
  };
  const submit = () => {
    setTried(true);
    if (Object.keys(problems).length > 0) return;
    proposal.mutation.mutate({ body: toManifest(project, form, stored), create: !stored });
  };
  const shownError = (field: string) => (tried && problems[field] ? [t(problems[field], { max: MAX_MEMBERS })] : undefined);

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="xl"
      title={stored ? t("mcp.form.editTitle", { name: stored.metadata.name }) : t("mcp.form.newTitle")}
      description={t("mcp.form.lead")}
      closeLabel={t("app.close")}
      footer={
        change ? (
          <Button onClick={() => close(false)}>{t("app.close")}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              {t("form.cancel")}
            </Button>
            <Button loading={proposal.mutation.isPending} onClick={submit}>
              {t("mcp.form.propose")}
            </Button>
          </>
        )
      }
    >
      {change ? (
        <ChangeNotice change={change} project={project} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="mcp-name" label={t("mcp.field.name")} required help={t("mcp.help.name")} errors={shownError("name")}>
              <Input
                id="mcp-name"
                value={form.name}
                readOnly={Boolean(stored)}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set({ name: event.target.value.trim() })}
              />
            </Field>
            <Field id="mcp-title" label={t("mcp.field.title")} help={t("mcp.help.title")}>
              <Input id="mcp-title" value={form.title} maxLength={120} onChange={(event) => set({ title: event.target.value })} />
            </Field>
          </div>
          <Field id="mcp-description" label={t("mcp.field.description")} help={t("mcp.help.description")}>
            <Textarea
              id="mcp-description"
              rows={2}
              maxLength={1000}
              value={form.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-body font-semibold">{t("mcp.field.members", { count: form.members.length, max: MAX_MEMBERS })}</legend>
            <p className="text-caption text-fg-muted">{t("mcp.help.members")}</p>
            <Field id="mcp-member-search" label={t("mcp.field.search")}>
              <Input id="mcp-member-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
            </Field>
            {choicesLoading ? <p role="status">{t("app.loading")}</p> : null}
            {!choicesLoading && shown.length === 0 ? <p>{t("mcp.form.noEndpoints")}</p> : null}
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
              {shown.map((choice) => {
                const key = memberKey(choice);
                const on = form.members.includes(key);
                const full = !on && form.members.length >= MAX_MEMBERS;
                return (
                  <li key={key} className="flex flex-wrap items-center justify-between gap-2">
                    <Checkbox
                      label={`${choice.title} (${key})`}
                      checked={on}
                      disabled={!choice.servesMcp || full}
                      disabledReason={!choice.servesMcp ? t("mcp.form.servesNoMcp") : full ? t("mcp.form.full", { max: MAX_MEMBERS }) : undefined}
                      onChange={(event) => toggle(key, event.target.checked)}
                    />
                    <Badge tone={choice.audience === "public" ? "accent" : "neutral"}>{t(`mcp.audience.${choice.audience}`)}</Badge>
                  </li>
                );
              })}
            </ul>
            {unseen.length > 0 ? <p className="text-caption text-fg-muted">{t("mcp.form.unseen", { count: unseen.length })}</p> : null}
            {shownError("members") ? (
              <p role="alert" className="text-caption text-danger">
                {shownError("members")?.[0]}
              </p>
            ) : null}
          </fieldset>

          <div className="grid gap-4 md:grid-cols-2">
            <Field id="mcp-audience" label={t("mcp.field.audience")} required help={t("mcp.help.audience")} errors={shownError("audience")}>
              <Select id="mcp-audience" value={form.audience} onChange={(event) => set({ audience: event.target.value as Audience })}>
                {AUDIENCES.map((audience) => (
                  <option key={audience} value={audience} disabled={breadth(audience) > breadth(widest)}>
                    {t(`mcp.audience.${audience}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {form.audience === "project-list" ? (
              <Field id="mcp-projects" label={t("mcp.field.allowedProjects")} help={t("mcp.help.allowedProjects")} errors={shownError("allowedProjects")}>
                <Input
                  id="mcp-projects"
                  value={form.allowedProjects.join(", ")}
                  onChange={(event) =>
                    set({
                      allowedProjects: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
          {form.audience === "public" ? (
            <Alert tone="warning" role="status">
              {t("mcp.form.publicLane")}
            </Alert>
          ) : null}

          <ToolPreview members={picked} />

          {proposal.error ? (
            <Alert tone="danger" role="alert">
              {proposal.error}
            </Alert>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
