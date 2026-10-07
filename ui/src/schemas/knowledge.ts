// The forms of the knowledge assistant's two kinds (MF-51, MF-52, T-3057), mirroring jc-core's
// `KnowledgeSourceSpec` and `AssistantDeploymentSpec` field for field, with their bounds.
import type { JsonSchema } from "../components/forms/types";
import type { ResourceProposal } from "../api/manifest";
import { DNS1123, words } from "./kinds";

/** Five-field cron, the shape jc-core accepts for `schedule`. */
const CRON = "^\\S+ \\S+ \\S+ \\S+ \\S+$";
/** An absolute https address with a host, as a start URL is. */
const HTTPS_URL = "^https://[^\\s/?#]+(/\\S*)?$";
/** An origin a deployment may be placed on: https, a host, a port at most, no path. */
const ORIGIN = "^https://[^\\s/?#:*]+(:[0-9]{1,5})?$";
const LANGUAGE = "^[a-z]{2}$";

export const SOURCE_TYPES = ["website", "ckan"] as const;
export const VISIBILITIES = ["internal", "public"] as const;
export const CHANNELS = ["public", "internal", "ckan", "iframe"] as const;
export const PDF_POLICIES = ["include", "exclude"] as const;
/** The tools of an Endpoint's MCP surface a connector may name (the gateway's endpoint façade). */
export const ENDPOINT_TOOLS = [
  "list_types",
  "list_attributes",
  "query_entities",
  "get_entity",
  "query_temporal",
  "retrieve_temporal",
] as const;

export function knowledgeSourceSchema(t: (key: string) => string, catalogues: string[] = []): JsonSchema {
  return {
    type: "object",
    required: ["name", "source", "visibility"],
    properties: {
      name: { type: "string", title: t("knowledge.field.name"), pattern: DNS1123, maxLength: 63 },
      source: { type: "string", title: t("knowledge.field.source"), default: "website", ...words(t, "knowledge.type", SOURCE_TYPES) },
      startUrls: {
        type: "array",
        title: t("knowledge.field.startUrls"),
        items: { type: "string", pattern: HTTPS_URL, maxLength: 2048 },
        maxItems: 20,
        uniqueItems: true,
      },
      ckanInstanceRef: {
        type: "string",
        title: t("knowledge.field.ckanInstanceRef"),
        ...(catalogues.length > 0 ? { enum: catalogues } : { pattern: DNS1123 }),
      },
      sitemap: { type: "boolean", title: t("knowledge.field.sitemap"), default: true },
      include: {
        type: "array",
        title: t("knowledge.field.include"),
        items: { type: "string", pattern: "^/\\S*$", maxLength: 256 },
        maxItems: 50,
      },
      exclude: {
        type: "array",
        title: t("knowledge.field.exclude"),
        items: { type: "string", pattern: "^/\\S*$", maxLength: 256 },
        maxItems: 50,
      },
      maxDepth: { type: "integer", title: t("knowledge.field.maxDepth"), minimum: 1, maximum: 10, default: 3 },
      maxPages: { type: "integer", title: t("knowledge.field.maxPages"), minimum: 1, maximum: 50_000, default: 1_000 },
      pdf: {
        type: "object",
        title: t("knowledge.field.pdf"),
        properties: {
          policy: { type: "string", title: t("knowledge.field.pdfPolicy"), default: "include", ...words(t, "knowledge.pdfPolicy", PDF_POLICIES) },
          maxBytes: { type: "integer", title: t("knowledge.field.pdfMaxBytes"), minimum: 1, maximum: 200 * 1024 * 1024, default: 50 * 1024 * 1024 },
          maxPages: { type: "integer", title: t("knowledge.field.pdfMaxPages"), minimum: 1, maximum: 2_000, default: 500 },
        },
      },
      offDomainDocuments: { type: "boolean", title: t("knowledge.field.offDomainDocuments"), default: false },
      schedule: { type: "string", title: t("knowledge.field.schedule"), pattern: CRON, maxLength: 120 },
      languages: {
        type: "array",
        title: t("knowledge.field.languages"),
        items: { type: "string", pattern: LANGUAGE },
        uniqueItems: true,
      },
      visibility: { type: "string", title: t("knowledge.field.visibility"), default: "internal", ...words(t, "knowledge.visibility", VISIBILITIES) },
    },
  };
}

export function assistantDeploymentSchema(
  t: (key: string) => string,
  sources: string[] = [],
  endpoints: string[] = [],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "publicId", "channel"],
    properties: {
      name: { type: "string", title: t("knowledge.field.name"), pattern: DNS1123, maxLength: 63 },
      publicId: { type: "string", title: t("knowledge.field.publicId"), pattern: DNS1123, maxLength: 63 },
      channel: { type: "string", title: t("knowledge.field.channel"), default: "internal", ...words(t, "knowledge.channel", CHANNELS) },
      systemPrompt: { type: "string", title: t("knowledge.field.systemPrompt"), maxLength: 8_000 },
      sources: {
        type: "array",
        title: t("knowledge.field.sources"),
        items: sources.length > 0 ? { type: "string", enum: sources } : { type: "string", pattern: DNS1123 },
        uniqueItems: true,
      },
      connectors: {
        type: "array",
        title: t("knowledge.field.connectors"),
        items: {
          type: "object",
          required: ["endpoint", "tools"],
          properties: {
            endpoint: {
              type: "string",
              title: t("knowledge.field.connectorEndpoint"),
              ...(endpoints.length > 0 ? { enum: endpoints } : { pattern: DNS1123 }),
            },
            tools: {
              type: "array",
              title: t("knowledge.field.connectorTools"),
              items: { type: "string", enum: [...ENDPOINT_TOOLS] },
              minItems: 1,
              uniqueItems: true,
            },
            timeoutSeconds: { type: "integer", title: t("knowledge.field.connectorTimeout"), minimum: 1, maximum: 120, default: 20 },
          },
        },
      },
      allowedOrigins: {
        type: "array",
        title: t("knowledge.field.allowedOrigins"),
        items: { type: "string", pattern: ORIGIN },
        uniqueItems: true,
      },
      rateLimit: {
        type: "object",
        title: t("knowledge.field.rateLimit"),
        properties: {
          requestsPerMinute: { type: "integer", title: t("knowledge.field.requestsPerMinute"), minimum: 1, maximum: 600 },
          perClientPerMinute: { type: "integer", title: t("knowledge.field.perClientPerMinute"), minimum: 1, maximum: 120 },
        },
      },
      budget: {
        type: "object",
        title: t("knowledge.field.budget"),
        properties: {
          tokensPerDay: { type: "integer", title: t("knowledge.field.tokensPerDay"), minimum: 1, maximum: 100_000_000 },
          tokensPerConversation: { type: "integer", title: t("knowledge.field.tokensPerConversation"), minimum: 1, maximum: 100_000_000 },
        },
      },
      theme: {
        type: "object",
        title: t("knowledge.field.theme"),
        properties: {
          primaryColor: { type: "string", title: t("knowledge.field.primaryColor"), pattern: "^#[0-9a-fA-F]{6}$" },
          greeting: { type: "string", title: t("knowledge.field.greeting"), maxLength: 500 },
        },
      },
      languages: {
        type: "array",
        title: t("knowledge.field.languages"),
        items: { type: "string", pattern: LANGUAGE },
        uniqueItems: true,
      },
      sandbox: { type: "boolean", title: t("knowledge.field.sandbox"), default: false },
    },
  };
}

/** What a form holds: the name beside the spec's own fields. */
export type KindForm = Record<string, unknown> & { name?: string };

/** Drops what a form left empty, so the manifest carries only what was said (jc-core defaults the rest). */
function said(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }
  if (value && typeof value === "object") {
    const kept = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, inner]) => [key, said(inner)] as const)
        .filter(([, inner]) => inner !== undefined),
    );
    return Object.keys(kept).length > 0 ? kept : undefined;
  }
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  return value;
}

/**
 * A form as the manifest it proposes. The form shows every field of the spec, so its spec is the
 * whole spec: a field cleared on the form leaves the manifest. A stored manifest keeps its
 * metadata (labels, annotations), which the form does not show.
 */
export function toKindManifest(
  kind: "KnowledgeSource" | "AssistantDeployment",
  project: string,
  form: KindForm,
  stored?: unknown,
): ResourceProposal {
  const { name, ...spec } = form;
  const kept = (stored as { metadata?: Record<string, unknown> } | null | undefined)?.metadata ?? {};
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind,
    metadata: { ...kept, name: String(name ?? ""), namespace: project },
    spec: (said(spec) as Record<string, unknown> | undefined) ?? {},
  } as ResourceProposal;
}

/** A manifest as the form shows it. */
export function fromKindManifest(manifest: unknown): KindForm {
  const read = manifest as { metadata?: { name?: unknown }; spec?: unknown } | null | undefined;
  const spec = read?.spec && typeof read.spec === "object" ? (read.spec as Record<string, unknown>) : {};
  return { ...spec, name: typeof read?.metadata?.name === "string" ? read.metadata.name : "" };
}
