import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { digestOf, getDraft, putDraft, subscribeDrafts } from "../../api/drafts";
import type { Draft, DraftEvent, Verdict } from "../../api/drafts";
import { extractName, manifestOf } from "./resourceForm";
import type { ManifestSource } from "./types";

export interface ResourceDraftOptions<T> {
  open: boolean;
  project?: string;
  draftKind?: string;
  draftName?: string;
  formData?: T;
  source?: ManifestSource<T>;
  /** The digest of the manifest a page builds around the form (a hidden attribute lives outside it). */
  currentDigest: string;
  /** The page's own verdict, when it holds one; the hook's otherwise. */
  verdict?: Verdict | null;
  onVerdictChange?: (verdict: Verdict | null) => void;
  onChange?: (data: T | undefined) => void;
}

export interface ResourceDraft<T> {
  /** The name the draft is kept under: the page's `draftName`, else the form's own name. */
  activeName: string | undefined;
  currentDraft: Draft | null;
  verdict: Verdict | null;
  updateVerdict: (verdict: Verdict | null) => void;
  conflict: string | null;
  setConflict: (conflict: string | null) => void;
  /** Why the server would not save the draft (MF-24, T-2626), in its own words. */
  saveRefused: string | null;
  /**
   * The draft a proposal names, holding what the form shows: a proposal takes the draft's own
   * manifest, so the save the debounce has not sent yet goes first (T-0769, AG-61).
   */
  draftRefFor: (form: T) => Promise<{ kind: string; name: string } | undefined>;
  /** Forgets the draft on close, so the next open loads it again. */
  reset: () => void;
}

/** How long the form rests after a change before its draft is written. */
const DRAFT_WRITE_MS = 600;
/** A draft event this soon after a keystroke is the person's own write coming back. */
const OWN_ECHO_MS = 1500;

/** The server's own sentence for a refused save, else what the request failed with. */
function refusalOf(err: unknown, generic: string): string {
  const detail = (err as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail) return detail;
  return err instanceof Error ? err.message : generic;
}

/**
 * The draft a form edits (PF-57, MF-24): loaded on open, written 600 ms after a change that moved
 * its digest, reloaded when another window writes it, and the verdict it carries.
 */
export function useResourceDraft<T>(options: ResourceDraftOptions<T>): ResourceDraft<T> {
  const { open, project, draftKind, draftName, formData, source, currentDigest, onVerdictChange, onChange } =
    options;
  const { t } = useTranslation();
  const [currentDraft, setCurrentDraft] = useState<Draft | null>(null);
  // The draft name whose load has answered, with or without a draft: the write below waits
  // for it, and a name that has no draft yet must not wait forever (T-0631).
  const [loadedName, setLoadedName] = useState<string | undefined>(undefined);
  const [ownVerdict, setOwnVerdict] = useState<Verdict | null>(null);
  const verdict = options.verdict !== undefined ? options.verdict : ownVerdict;
  const [conflict, setConflict] = useState<string | null>(null);
  const [saveRefused, setSaveRefused] = useState<string | null>(null);
  const lastVersionRef = useRef<number | undefined>(undefined);
  const lastTypedRef = useRef<number>(0);
  /** The digest of the manifest the draft last held: an unchanged form writes nothing. */
  const syncedDigestRef = useRef<string | undefined>(undefined);
  /** The verdict on screen, for the answers below that arrive after a newer one (T-2624). */
  const heldVerdictRef = useRef<Verdict | null>(null);

  const activeName = draftName || extractName(formData);

  const updateVerdict = (next: Verdict | null) => {
    heldVerdictRef.current = next;
    setOwnVerdict(next);
    onVerdictChange?.(next);
  };
  /**
   * The verdict a save or a reload of the draft carries. The store keeps a draft's verdict
   * across a save, so a save that crosses a check in flight answers with the verdict from before
   * that check (none, or the one another hand ran on its own manifest). Taken as it came, it
   * replaced the fresh one and Propose stayed refused (T-2624). The newer check wins; the digest
   * still decides whether it is fresh for what the form holds (PF-57).
   */
  const adoptVerdict = (incoming: Verdict | null | undefined) => {
    if (incoming === undefined) {
      return;
    }
    const held = heldVerdictRef.current;
    if (held !== null && (incoming === null || Date.parse(incoming.checkedAt) < Date.parse(held.checkedAt))) {
      return;
    }
    updateVerdict(incoming);
  };

  /**
   * A draft opened is not the person's edit: what the form would write from it counts as synced,
   * so a draft holding a field the form has no control for is not rewritten without it on open.
   * Measured by the stored manifest instead, that write-back waited only on a re-render clearing
   * the debounce first (T-2754).
   */
  const showManifest = (manifest: unknown) => {
    const loaded = source ? source.fromManifest(manifest) : (manifest as T);
    syncedDigestRef.current = digestOf(source ? source.toManifest(loaded) : manifest);
    onChange?.(loaded);
  };
  /** A draft another hand wrote, read back: its version, its verdict and its manifest. */
  const takeReloaded = (reloaded: Draft | null) => {
    if (!reloaded) return;
    setCurrentDraft(reloaded);
    lastVersionRef.current = reloaded.version;
    adoptVerdict(reloaded.verdict);
    if (reloaded.manifest) showManifest(reloaded.manifest);
  };

  const onLoaded = useEffectEvent((d: Draft | null) => {
    setLoadedName(draftName);
    if (!d) return;
    setCurrentDraft(d);
    lastVersionRef.current = d.version;
    if (d.verdict !== undefined) {
      updateVerdict(d.verdict ?? null);
    }
    if (d.manifest) showManifest(d.manifest);
  });
  // Load existing draft on open if draftName is set
  useEffect(() => {
    if (!open || !draftKind || !project || !draftName) {
      return;
    }
    let active = true;
    void getDraft(project, draftKind, draftName).then((d) => {
      if (active) onLoaded(d);
    });
    return () => {
      active = false;
    };
  }, [open, draftKind, project, draftName]);

  const scheduleWrite = useEffectEvent((form: T | undefined): (() => void) | undefined => {
    if (!open || !draftKind || !project || !activeName || !form) {
      return undefined;
    }
    // A named draft is loaded before anything is written back: the form's first, empty
    // data must not overwrite what another window typed.
    if (draftName && loadedName !== draftName) {
      return undefined;
    }
    const manifest = manifestOf(form, source);
    const digest = digestOf(manifest);
    if (digest === syncedDigestRef.current) {
      return undefined;
    }
    lastTypedRef.current = Date.now();
    const timer = setTimeout(() => {
      // A proposal may have written this manifest already (see `draftRefFor`).
      if (digest === syncedDigestRef.current) {
        return;
      }
      void putDraft(project, draftKind, activeName, manifest, lastVersionRef.current)
        .then((d) => {
          syncedDigestRef.current = digest;
          setCurrentDraft(d);
          lastVersionRef.current = d.version;
          adoptVerdict(d.verdict);
          setConflict(null);
          setSaveRefused(null);
        })
        .catch((err: unknown) => {
          if ((err as { status?: number } | null)?.status !== 409) {
            setSaveRefused(refusalOf(err, t("app.error.generic")));
            return;
          }
          setConflict(t("drafts.conflict"));
          void getDraft(project, draftKind, activeName).then(takeReloaded);
        });
    }, DRAFT_WRITE_MS);
    return () => clearTimeout(timer);
  });
  // Debounced write of the draft on a form change. `currentDigest` stands for the manifest a page
  // builds around the form, which `formData` alone does not move.
  useEffect(
    () => scheduleWrite(formData),
    [formData, currentDigest, open, draftKind, project, activeName, draftName, loadedName],
  );

  const onDraftEvent = useEffectEvent((event: DraftEvent) => {
    if (!project || !draftKind || event.kind !== draftKind || event.name !== activeName) {
      return;
    }
    if (event.event === "drop") {
      setCurrentDraft(null);
      updateVerdict(null);
      return;
    }
    if (event.event === "verdict") {
      void getDraft(project, draftKind, activeName).then((d) => {
        if (d) {
          setCurrentDraft(d);
          adoptVerdict(d.verdict ?? null);
        }
      });
      return;
    }
    if (event.version > (lastVersionRef.current ?? 0) && Date.now() - lastTypedRef.current >= OWN_ECHO_MS) {
      void getDraft(project, draftKind, activeName).then(takeReloaded);
    }
  });
  // Subscribe to project draft events
  const hasDraft = currentDraft !== null;
  useEffect(() => {
    if (!open || !draftKind || !project || !hasDraft) {
      return;
    }
    return subscribeDrafts(project, (event) => onDraftEvent(event));
  }, [open, draftKind, project, activeName, hasDraft]);

  async function draftRefFor(form: T): Promise<{ kind: string; name: string } | undefined> {
    const active = draftName || extractName(form);
    if (!draftKind || !active) {
      return undefined;
    }
    const manifest = manifestOf(form, source);
    const digest = digestOf(manifest);
    const loaded = !draftName || loadedName === draftName;
    if (project && loaded && digest !== syncedDigestRef.current) {
      try {
        const saved = await putDraft(project, draftKind, active, manifest, lastVersionRef.current);
        syncedDigestRef.current = digest;
        lastVersionRef.current = saved.version;
        setCurrentDraft(saved);
        adoptVerdict(saved.verdict);
        setSaveRefused(null);
      } catch (err) {
        // Another window changed the draft: the person sees it before anything is proposed. Any
        // other failure leaves the proposal to the server's check, which says what to do.
        if ((err as { status?: number }).status === 409) {
          throw err;
        }
        setSaveRefused(refusalOf(err, t("app.error.generic")));
      }
    }
    return { kind: draftKind, name: active };
  }

  function reset() {
    setConflict(null);
    setCurrentDraft(null);
    setLoadedName(undefined);
    lastVersionRef.current = undefined;
  }

  return {
    activeName,
    currentDraft,
    verdict,
    updateVerdict,
    conflict,
    setConflict,
    saveRefused,
    draftRefFor,
    reset,
  };
}
