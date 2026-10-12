/**
 * Upload a CSV into a Context Space (DM-81, T-3840): the file is ranked against the Smart Data
 * Models types of the city subjects, the person takes a type or their own, `jc_space_complete`
 * proposes the model, the space, its Endpoint and the person's write grant as one Change, and once
 * that Change is live the rows are upserted through the gateway with the person's own session.
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { download, originTransport } from "@joinedcontext/sdk";
import { api, unwrap } from "../../api/client";
import { callOperation } from "../../api/operations";
import { useOrgDomain } from "../../api/projects";
import type { Change } from "../../api/manifest";
import { ChangeNotice } from "../../components/ChangeNotice";
import { ResourceNamePicker } from "../../components/pickers/ResourceNamePicker";
import { Alert, Button, Card, Field, FilePicker, Input, PageHeader, RadioGroup } from "../../components/ui";
import { CITY_SUBJECTS, SAMPLE_BYTES, modelsOf, rankModels, sampleOf, uploadInput } from "./csvUpload";
import type { SdmMatch } from "./csvUpload";
import { createInBatches, importSlotsOf, readTable, rejectedCsv, suggestMapping, toEntities } from "./importRows";
import type { Rejected, Table } from "./importRows";

/** How many entities the preview shows as NGSI-LD before they are written. */
const PREVIEW = 10;

/** A type name the person writes for their own model: PascalCase, as the op names the class. */
const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,62}$/;

type Read = { table: Table; name: string; sample: string; matches: SdmMatch[] };
type Proposed = { space: string; type: string; source: string | undefined; change: Change | null };

export function UploadCsv({ project, space: given = "" }: { project: string; space?: string }): JSX.Element {
  const { t } = useTranslation();
  const orgDomain = useOrgDomain(project);
  const [read, setRead] = useState<Read | null>(null);
  // The chosen Smart Data Models id, or "" for the person's own model.
  const [choice, setChoice] = useState("");
  const [ownType, setOwnType] = useState("");
  const [space, setSpace] = useState(given);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [proposed, setProposed] = useState<Proposed | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [done, setDone] = useState<{ written: number; rejected: Rejected[] } | null>(null);

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const choose = async (file: File) => {
    setProblem(null);
    setRead(null);
    setProposed(null);
    setDone(null);
    try {
      const table = await readTable(file);
      if (table.rows.length === 0) {
        setProblem(t("spaces.import.empty"));
        return;
      }
      const sample = sampleOf(await file.slice(0, SAMPLE_BYTES).text());
      // The catalogue is a help, not a gate: unreachable, the file still gets its own model.
      let matches: SdmMatch[] = [];
      try {
        const catalogue = await unwrap(
          await api.GET("/api/v1/tools/sdm-catalog", { params: { query: { subject: CITY_SUBJECTS.join(",") } } }),
        );
        matches = rankModels(table.columns, modelsOf(catalogue as Parameters<typeof modelsOf>[0]));
      } catch {
        matches = [];
      }
      setRead({ table, name: file.name, sample, matches });
      setChoice(matches[0]?.model.id ?? "");
    } catch (error) {
      setProblem(t("spaces.import.unreadable", { reason: reason(error) }));
    }
  };

  const match = read?.matches.find((m) => m.model.id === choice);
  const typeName = match ? match.model.name : ownType.trim();
  const ready = read !== null && space.trim() !== "" && TYPE_NAME.test(typeName);

  const propose = async () => {
    if (!read || !ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const linkml = match
        ? ((await unwrap(await api.POST("/api/v1/tools/import-sdm", { body: { model: match.model.id } }))) as { linkml?: string }).linkml
        : undefined;
      const answer = await callOperation(
        project,
        "jc_space_complete",
        uploadInput({ space: space.trim(), fileName: read.name, sample: read.sample, typeName, linkml }),
      );
      if (!answer.ok) {
        setProblem(answer.reason ?? `HTTP ${answer.status}`);
        return;
      }
      const out = answer.output as { space: string; drafts: { kind: string; manifest: { spec?: { source?: unknown } } }[]; change?: Change | null };
      const drafted = out.drafts.find((d) => d.kind === "DataModel")?.manifest.spec?.source;
      setProposed({ space: out.space, type: typeName, source: linkml ?? (typeof drafted === "string" ? drafted : undefined), change: out.change ?? null });
    } catch (error) {
      setProblem(reason(error));
    } finally {
      setBusy(false);
    }
  };

  const slots = useMemo(() => importSlotsOf(proposed?.source, proposed?.type ?? ""), [proposed]);
  const checked = useMemo(() => {
    if (!read || !proposed || slots.length === 0) return null;
    const target = { type: proposed.type, orgDomain, space: proposed.space };
    return toEntities(read.table, suggestMapping(read.table.columns, slots), slots, target);
  }, [read, proposed, slots, orgDomain]);

  const write = async () => {
    if (!proposed || !checked) return;
    const total = checked.entities.length;
    setProgress({ sent: 0, total });
    // Upsert: the same file uploaded again writes the same entities, not a second copy.
    const answer = await createInBatches(originTransport(), proposed.space, checked.entities, (sent) => setProgress({ sent, total }), "upsert");
    setProgress(null);
    setDone({ written: answer.created, rejected: [...checked.rejected, ...answer.rejected].sort((a, b) => a.row - b.row) });
  };

  return (
    <div className="flex flex-col gap-section">
      <PageHeader title={t("spaces.upload.title")} description={t("spaces.upload.lead")} />
      {problem ? (
        <Alert role="alert" tone="danger">
          {problem}
        </Alert>
      ) : null}
      <Card className="flex flex-col gap-4">
        <FilePicker label={t("spaces.upload.choose")} accept=".csv,.tsv,.txt" onFile={(file) => void choose(file)}>
          <span className="inline-flex items-center rounded-md border border-dashed border-border px-4 py-3 text-body">
            {t("spaces.upload.choose")}
          </span>
        </FilePicker>
        {read ? (
          <p className="text-body text-fg-muted">
            {t("spaces.import.read", { name: read.name, rows: read.table.rows.length, columns: read.table.columns.length })}
          </p>
        ) : null}
      </Card>
      {read && !proposed ? (
        <Card className="flex flex-col gap-4">
          {read.matches.length === 0 ? <p className="text-body text-fg-muted">{t("spaces.upload.noMatch")}</p> : null}
          <RadioGroup
            name="upload-type"
            legend={t("spaces.upload.type")}
            value={choice}
            onChange={setChoice}
            options={[
              ...read.matches.map((m) => ({
                value: m.model.id,
                label: t("spaces.upload.match", { name: m.model.name, score: Math.round(m.score * 100) }),
                description: Object.entries(m.mapping)
                  .map(([column, attribute]) => `${column} → ${attribute}`)
                  .join(", "),
              })),
              { value: "", label: t("spaces.upload.own") },
            ]}
          />
          {choice === "" ? (
            <Field id="upload-own-type" label={t("spaces.upload.ownType")} help={t("spaces.upload.ownTypeHint")}>
              <Input id="upload-own-type" value={ownType} onChange={(e) => setOwnType(e.target.value)} placeholder="ParkingGarage" />
            </Field>
          ) : null}
          <Field id="upload-space" label={t("spaces.upload.space")}>
            <ResourceNamePicker id="upload-space" label={t("spaces.upload.space")} labelled from={{ project, plural: "spaces" }} value={space} onChange={setSpace} create />
          </Field>
          <Button className="w-fit" onClick={() => void propose()} disabled={!ready || busy} disabledReason={t("spaces.upload.notReady")}>
            {busy ? t("spaces.upload.proposing") : t("spaces.upload.propose")}
          </Button>
        </Card>
      ) : null}
      {proposed ? (
        <Card className="flex flex-col gap-4">
          {proposed.change ? <ChangeNotice change={proposed.change} project={project} /> : null}
          <p className="text-body">{t("spaces.upload.afterApproval", { space: proposed.space, type: proposed.type })}</p>
          {checked ? (
            <p role="status" className="text-body">
              {t("spaces.import.checked", { valid: checked.entities.length, refused: checked.rejected.length })}
            </p>
          ) : (
            <Alert tone="warning">{t("spaces.upload.noSlots")}</Alert>
          )}
          {checked && checked.entities.length > 0 ? (
            <details>
              <summary className="focus-ring cursor-pointer rounded-md text-body font-medium text-fg">
                {t("spaces.upload.preview", { count: Math.min(PREVIEW, checked.entities.length) })}
              </summary>
              <pre className="max-h-80 overflow-auto rounded-md bg-surface-muted p-3 font-mono text-caption" data-testid="upload-preview">
                {JSON.stringify(checked.entities.slice(0, PREVIEW).map((each) => each.entity), null, 2)}
              </pre>
            </details>
          ) : null}
          {progress ? (
            <p role="status" className="text-body">
              {t("spaces.import.writing", progress)}
            </p>
          ) : (
            <Button className="w-fit" onClick={() => void write()} disabled={!checked || checked.entities.length === 0} disabledReason={t("spaces.import.nothingToCreate")}>
              {t("spaces.upload.write", { count: checked?.entities.length ?? 0 })}
            </Button>
          )}
          {done ? (
            <>
              <Alert role="status" tone={done.rejected.length === 0 ? "success" : done.written > 0 ? "warning" : "danger"}>
                {t("spaces.upload.done", { written: done.written, refused: done.rejected.length })}
              </Alert>
              {done.rejected.length > 0 ? (
                <Button
                  variant="secondary"
                  className="w-fit"
                  onClick={() => download(new Blob([rejectedCsv(done.rejected)], { type: "text/csv" }), `${proposed.type}-refused.csv`)}
                >
                  {t("spaces.import.downloadRefused")}
                </Button>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
