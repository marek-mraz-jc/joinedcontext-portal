import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import type { Manifest, ResourceProposal } from "../../api/manifest";
import { proposeChecked } from "../../api/proposal";
import {
  Alert,
  Button,
  ConfirmDialog,
  Input,
  PermissionGuard,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { fromIso, HISTORY_FOREVER, HISTORY_OFF, shortens, toIso, UNITS, written } from "./retention";
import type { RetentionRule, Unit } from "./retention";

type Count = components["schemas"]["RetentionCount"];

/** One duration as the editor holds it: what the person typed, forever, or history off. */
interface Cell {
  amount: string;
  unit: Unit | "forever" | "off";
  /** The stored duration, written back as it was while the cell shows it unchanged. */
  stored?: string;
}

function cellOf(iso?: string): Cell {
  if (iso === HISTORY_OFF) return { amount: "", unit: "off", stored: iso };
  const keep = iso === undefined ? undefined : fromIso(iso);
  return keep === undefined
    ? { amount: "", unit: "forever", stored: iso }
    : { amount: String(keep.amount), unit: keep.unit, stored: iso };
}

/** The manifest's duration of a cell; `null` when the person typed something the broker refuses. */
function isoOf(cell: Cell): string | undefined | null {
  if (cell.unit === "off") return HISTORY_OFF;
  // A history the manifest keeps forever with its reason stays as written (T-4275).
  if (cell.unit === "forever") return cell.stored === HISTORY_FOREVER ? HISTORY_FOREVER : undefined;
  const iso = toIso({ amount: Number(cell.amount), unit: cell.unit });
  if (iso === undefined) return null;
  const stored = cell.stored === undefined ? undefined : fromIso(cell.stored);
  return stored !== undefined && toIso(stored) === iso ? cell.stored : iso;
}

function rulesOf(manifest: Manifest): RetentionRule[] {
  const rules = (manifest.spec as { retention?: unknown } | undefined)?.retention;
  return Array.isArray(rules) ? (rules as RetentionRule[]) : [];
}

/**
 * How long a space keeps each type's data (DM-82, DM-85, ADR-N-046): the rules in plain units,
 * what the broker's sweeps deleted, and for the space's owners an editor that names what a shorter
 * rule deletes before it is proposed. A type without a rule is kept forever.
 */
export function SpaceRetention({
  project,
  space,
  manifest,
  types,
}: {
  project: string;
  space: string;
  manifest: Manifest;
  types: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const held = rulesOf(manifest);
  const shown = [...new Set([...types, ...held.map((rule) => rule.entityType)])].sort();
  const [draft, setDraft] = useState<Record<string, { current: Cell; history: Cell }> | null>(null);
  const [counts, setCounts] = useState<Count[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);

  const deleted = useQuery({
    queryKey: ["projects", project, "spaces", space, "retention", "deleted"],
    retry: false,
    queryFn: async () =>
      (
        await unwrap(
          await api.GET("/api/v1/projects/{project}/spaces/{space}/retention/deleted", {
            params: { path: { project, space } },
          }),
        )
      ).counts,
  });

  const said = (error: unknown) =>
    error instanceof ApiError ? (error.problem?.detail ?? error.message) : String(error);

  const propose = useMutation({
    mutationFn: async (rules: RetentionRule[]) => {
      const { status: _status, ...envelope } = manifest as Manifest & { status?: unknown };
      const body = {
        ...envelope,
        spec: { ...(manifest.spec as object), retention: rules },
      } as unknown as ResourceProposal;
      return proposeChecked(project, "spaces", body, false);
    },
    onSuccess: () => {
      setDraft(null);
      setCounts(null);
      setProposed(true);
      void queryClient.invalidateQueries({ queryKey: ["projects", project] });
    },
    onError: (error) => setProblem(said(error)),
  });

  const preview = useMutation({
    mutationFn: async (rules: RetentionRule[]) =>
      (
        await unwrap(
          await api.POST("/api/v1/projects/{project}/spaces/{space}/retention/preview", {
            params: { path: { project, space } },
            body: { retention: rules as unknown as Record<string, unknown>[] },
          }),
        )
      ).counts,
    onSuccess: setCounts,
    onError: (error) => setProblem(said(error)),
  });

  const ruleOf = (type: string) => held.find((rule) => rule.entityType === type);
  const plain = (iso?: string) => {
    if (iso === HISTORY_OFF) return t("spaces.retention.offShown");
    if (iso === HISTORY_FOREVER) return t("spaces.retention.forever");
    const keep = iso === undefined ? undefined : fromIso(iso);
    return keep === undefined
      ? iso === undefined
        ? t("spaces.retention.forever")
        : iso
      : t(`spaces.retention.amount.${keep.unit}`, { count: keep.amount });
  };
  const removed = (type: string) => {
    const rows = (deleted.data ?? []).filter((row) => row.entityType === type);
    const of = (kind: string) => rows.find((row) => row.kind === kind)?.count ?? 0;
    return t("spaces.retention.removed", { current: of("entity"), history: of("history") });
  };

  const drafted = (): RetentionRule[] | null => {
    if (draft === null) return null;
    const rules: RetentionRule[] = [];
    for (const type of shown) {
      const current = isoOf(draft[type].current);
      const history = isoOf(draft[type].history);
      if (current === null || history === null) return null;
      rules.push({ entityType: type, current, history, reason: ruleOf(type)?.reason });
    }
    return written(rules);
  };

  const save = () => {
    setProblem(null);
    const rules = drafted();
    if (rules === null) {
      setProblem(t("spaces.retention.invalid"));
      return;
    }
    if (shortens(held, rules)) {
      preview.mutate(rules);
    } else {
      propose.mutate(rules);
    }
  };

  const edit = () => {
    setProposed(false);
    setDraft(
      Object.fromEntries(
        shown.map((type) => [
          type,
          { current: cellOf(ruleOf(type)?.current), history: cellOf(ruleOf(type)?.history) },
        ]),
      ),
    );
  };

  const editor = (type: string, kind: "current" | "history") => {
    if (draft === null) return null;
    const cell = draft[type][kind];
    const set = (next: Partial<Cell>) =>
      setDraft({ ...draft, [type]: { ...draft[type], [kind]: { ...cell, ...next } } });
    const label = t(`spaces.retention.${kind}`);
    return (
      <span className="flex gap-2">
        {cell.unit !== "forever" && cell.unit !== "off" && (
          <Input
            type="number"
            min={1}
            className="w-20"
            aria-label={t("spaces.retention.amountOf", { type, what: label })}
            value={cell.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
        )}
        <Select
          aria-label={t("spaces.retention.unitOf", { type, what: label })}
          value={cell.unit}
          onChange={(event) => set({ unit: event.target.value as Cell["unit"], amount: cell.amount || "1" })}
        >
          {/* History is Off or kept for a while; forever stays only where it already is (T-4275). */}
          {kind === "current" ? (
            <option value="forever">{t("spaces.retention.forever")}</option>
          ) : (
            <>
              {(cell.stored === undefined || cell.stored === HISTORY_FOREVER) && (
                <option value="forever">{t("spaces.retention.foreverAsNow")}</option>
              )}
              <option value="off">{t("spaces.retention.off")}</option>
            </>
          )}
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {t(`spaces.retention.unit.${unit}`)}
            </option>
          ))}
        </Select>
      </span>
    );
  };

  const pending = drafted();
  return (
    <div className="space-y-3">
      <p className="text-body text-fg-muted">{t("spaces.retention.lead")}</p>
      {shown.length === 0 ? (
        <p className="text-body text-fg-muted">{t("spaces.retention.noTypes")}</p>
      ) : (
        <Table caption={t("spaces.retention.caption")}>
          <TableHead>
            <TableHeaderCell>{t("spaces.retention.type")}</TableHeaderCell>
            <TableHeaderCell>{t("spaces.retention.current")}</TableHeaderCell>
            <TableHeaderCell>{t("spaces.retention.history")}</TableHeaderCell>
            <TableHeaderCell>{t("spaces.retention.deleted")}</TableHeaderCell>
          </TableHead>
          <TableBody>
            {shown.map((type) => (
              <TableRow key={type}>
                <TableCell>{type}</TableCell>
                <TableCell>{editor(type, "current") ?? plain(ruleOf(type)?.current)}</TableCell>
                <TableCell>{editor(type, "history") ?? plain(ruleOf(type)?.history)}</TableCell>
                <TableCell>{deleted.isError ? t("spaces.retention.deletedUnknown") : removed(type)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {problem !== null && <Alert tone="danger">{problem}</Alert>}
      {proposed && <Alert tone="success">{t("spaces.retention.proposed")}</Alert>}
      {draft === null ? (
        shown.length > 0 && (
          <PermissionGuard project={project} kind="ContextSpace" verb="approve">
            <Button variant="secondary" onClick={edit}>
              {t("spaces.retention.edit")}
            </Button>
          </PermissionGuard>
        )
      ) : (
        <span className="flex gap-2">
          <Button onClick={save} loading={preview.isPending || propose.isPending}>
            {t("spaces.retention.save")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(null);
              setProblem(null);
            }}
          >
            {t("spaces.retention.cancel")}
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={counts !== null}
        onOpenChange={(open) => {
          if (!open) setCounts(null);
        }}
        title={t("spaces.retention.confirmTitle", { space })}
        description={t("spaces.retention.confirmLead")}
        confirmLabel={t("spaces.retention.confirm")}
        pending={propose.isPending}
        onConfirm={() => {
          if (pending !== null) propose.mutate(pending);
        }}
      >
        {counts !== null && counts.length === 0 ? (
          <p className="text-body">{t("spaces.retention.nothingNow")}</p>
        ) : (
          <ul className="list-disc pl-5 text-body">
            {(counts ?? []).map((row) => (
              <li key={`${row.entityType}-${row.kind}`}>
                {t(`spaces.retention.wouldDelete.${row.kind === "entity" ? "entity" : "history"}`, {
                  type: row.entityType,
                  count: row.count,
                })}
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}
