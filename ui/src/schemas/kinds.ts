import { parse as parseYaml } from "yaml";
import {
  OPERATION_GROUP_NAMES,
  expandOperations,
} from "../components/endpoints/operationGroups";
import { gridConfigSchema } from "@joinedcontext/sdk";
import type { JsonSchema, UiSchema } from "../components/forms/types";

/**
 * Draft-07 schemas for the kinds the Portal writes, mirroring jc-core's `ContextSpaceSpec`
 * and `EndpointSpec` field for field. T-0249 replaces this file with the schemas the crate
 * itself exports; until the Portal can depend on it, a form needs a schema from somewhere.
 */

/** DNS-1123 label: what every manifest name and every space slug has to be (PF-09). */
export const DNS1123 = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";

/** RFC 4648 base32, lowercase, unpadded; 26 characters carry 130 bits of entropy (EP-02). */
export const SLUG_PATTERN = "^[a-z2-7]{26,}$";

/**
 * A manifest title is one plain string in the author's language (UI-50): one box, never a
 * language per input. A legacy map is collapsed by `plainTitle` before the form sees it.
 */
function titleProperty(label: string) {
  return { type: "string", title: label } as const;
}

export function contextSpaceSchema(t: (key: string) => string): JsonSchema {
  return {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        title: t("spaces.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      title: titleProperty(t("spaces.field.title")),
      dataModelRef: { type: "string", title: t("spaces.field.dataModel") },
      defaultLocale: {
        type: "string",
        title: t("spaces.field.locale"),
        enum: ["sk", "en", "de", "cs"],
      },
      isSandbox: { type: "boolean", title: t("spaces.field.sandbox"), default: false },
      ttlDays: {
        type: "integer",
        title: t("spaces.field.ttlDays"),
        minimum: 1,
        maximum: 14,
      },
    },
  };
}

export const REPRESENTATIONS = [
  "ngsi-ld",
  "geojson",
  "csv",
  "json",
  "xlsx",
  "zip",
  "ogc-features",
  "sta",
  "mcp",
] as const;

export const AUDIENCES = ["project-list", "organization", "public"] as const;

/**
 * The token-bucket classes a steward chooses between (EP-20).
 *
 * The contract field is a plain requests-per-minute number, and any number is valid on the
 * wire. Naming three of them is what turns a capacity decision into one somebody can make
 * without a calculator: strict for a hand-written client, standard for an application,
 * open for a scraper that pages through everything.
 */
export const RATE_LIMIT_CLASSES = { strict: 60, standard: 600, open: 6000 } as const;

/**
 * The schema formalisms an Endpoint publishes under `schema/v{major}/` (EP-46, EP-49).
 *
 * Every Endpoint serves all of them, so this is what to look at, never what to switch on.
 * The gateway compiles the first two itself and answers 406 for the rest until Model Tools
 * has committed them beside the source.
 */
export const SCHEMA_FORMALISMS = [
  "json-schema",
  "context.jsonld",
  "model.linkml.yaml",
  "model.ttl",
  "model.md",
] as const;

export type SchemaFormalism = (typeof SCHEMA_FORMALISMS)[number];

export function endpointSchema(
  t: (key: string) => string,
  spaces: string[],
  projects: string[] = [],
  perMinute?: number,
  catalogues: string[] = [],
): JsonSchema {
  // A limit set outside the form (YAML, the API, the assistant) is valid on the wire, so it
  // stays a choice of its own instead of an invalid field nobody can propose past.
  const classes: [string, number][] = Object.entries(RATE_LIMIT_CLASSES);
  const own =
    Number.isInteger(perMinute) && perMinute !== undefined && perMinute > 0 && !classes.some(([, value]) => value === perMinute)
      ? [["custom", perMinute] as [string, number]]
      : [];
  return {
    type: "object",
    required: ["name", "contextSpaceRef", "audience", "enabledRepresentations"],
    properties: {
      name: {
        type: "string",
        title: t("endpoints.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      title: titleProperty(t("endpoints.field.title")),
      contextSpaceRef: {
        type: "string",
        title: t("endpoints.field.space"),
        ...(spaces.length > 0 ? { enum: spaces } : {}),
      },
      audience: {
        type: "string",
        title: t("endpoints.field.audience"),
        // The stored value stays the contract's word; the person reads what it means.
        oneOf: AUDIENCES.map((audience) => ({
          const: audience,
          title: t(`endpoints.audienceOption.${audience}`),
        })),
        default: "project-list",
      },
      enabledRepresentations: {
        type: "array",
        title: t("endpoints.field.representations"),
        items: {
          type: "string",
          oneOf: REPRESENTATIONS.map((representation) => ({
            const: representation,
            title: t(`endpoints.representationOption.${representation}`),
          })),
        },
        uniqueItems: true,
        minItems: 1,
      },
      // Required by the manifest when the audience is `project-list` and refused for the
      // other two (EP-14, EP-15). The page drops the property for the other two audiences and
      // prunes the value on the way out, because rjsf cannot both hide a field and keep the
      // value somebody already typed into it. With the project list at hand the field is a
      // set of checkboxes over the other projects of the repository, not free text (PF-05).
      allowedProjects: {
        type: "array",
        title: t("endpoints.field.allowedProjects"),
        items:
          projects.length > 0
            ? { type: "string", enum: projects }
            : { type: "string", pattern: DNS1123 },
        uniqueItems: true,
      },
      rateLimits: {
        type: "object",
        title: t("endpoints.field.rateLimits"),
        properties: {
          // EP-20 asks every endpoint to configure a limit, so the form carries one rather
          // than letting a steward publish an unlimited endpoint by leaving a field alone.
          // The Change shows it like any other field, so nothing lands unseen.
          requestsPerMinute: {
            type: "integer",
            title: t("endpoints.field.requestsPerMinute"),
            default: RATE_LIMIT_CLASSES.standard,
            oneOf: [...classes, ...own]
              .sort(([, a], [, b]) => a - b)
              .map(([name, value]) => ({
                const: value,
                title: `${t(`endpoints.rateClass.${name}`)} (${value}/min)`,
              })),
          },
          burst: {
            type: "integer",
            title: t("endpoints.field.burst"),
            minimum: 1,
            maximum: 10000,
          },
        },
      },
      caching: {
        type: "object",
        title: t("endpoints.field.caching"),
        properties: {
          maxAgeSeconds: {
            type: "integer",
            title: t("endpoints.field.maxAge"),
            minimum: 0,
            maximum: 3600,
            multipleOf: 30,
          },
        },
      },
      // Publication to the open-data catalogue (EP-62…EP-65). Naming a catalogue is what turns it
      // on: the page writes no `publish` block while the field is empty, so an endpoint nobody
      // published stays out of the catalogue rather than carrying an empty declaration. The
      // dataset's visibility is not a field here: it follows `audience`, closed by default, and a
      // form that offered it would be offering to contradict the endpoint (EP-69).
      publish: {
        type: "object",
        title: t("endpoints.field.publish"),
        properties: {
          ckan: {
            type: "object",
            title: t("endpoints.field.openData"),
            properties: {
              instanceRef: {
                type: "string",
                title: t("endpoints.field.ckanInstance"),
                ...(catalogues.length > 0
                  ? { enum: catalogues }
                  : { pattern: DNS1123, maxLength: 63 }),
              },
              organization: {
                type: "string",
                title: t("endpoints.field.ckanOrganization"),
                pattern: CKAN_ORGANIZATION,
                maxLength: 100,
              },
              name: {
                type: "string",
                title: t("endpoints.field.catalogue"),
                pattern: DNS1123,
                maxLength: 63,
              },
              datastore: {
                type: "object",
                title: t("endpoints.field.datastore"),
                properties: {
                  // No default: a sheet is a full copy of the rows inside the catalogue, so it
                  // exists when a person chose the representation it is read through and not
                  // because a default filled itself in (EP-65).
                  representation: {
                    type: "string",
                    title: t("endpoints.field.sheetFrom"),
                    enum: [...DATASTORE_REPRESENTATIONS],
                  },
                  refresh: {
                    type: "string",
                    title: t("endpoints.field.sheetRefresh"),
                    oneOf: DATASTORE_REFRESH.map((refresh) => ({
                      const: refresh,
                      title: t(`endpoints.refreshOption.${refresh}`),
                    })),
                    default: "onChange",
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * The representations a DataStore sheet can be filled from (EP-65).
 *
 * `csv` alone: the publisher reads the tabular file and refuses `xlsx` and `file` with the fix
 * named, because a spreadsheet is a binary the gateway builds and the JSON file is not a tabular
 * projection (`crates/jcctl/src/commands/publish_ckan.rs`). The manifest validator admits all
 * three, so offering the two that fail would be a form that writes a manifest the publisher stops
 * on.
 */
export const DATASTORE_REPRESENTATIONS = ["csv"] as const;

/** How the sheet is kept current (EP-65): by the endpoint's subscription, or on every tick. */
export const DATASTORE_REFRESH = ["onChange", "onReconcile"] as const;

/** A CKAN organization slug: lowercase letters, digits and hyphens, as CKAN itself accepts. */
export const CKAN_ORGANIZATION = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";

/** Checkboxes for the representation set, a slider for the cache TTL; the rest is default. */
export const endpointUiSchema: UiSchema = {
  enabledRepresentations: { "ui:widget": "checkboxes" },
  caching: { maxAgeSeconds: { "ui:widget": "range" } },
};

/**
 * 26 lowercase base32 characters from the platform CSPRNG: 130 bits, no space or project
 * name anywhere in it (EP-02, EP-03).
 */
export function generateSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  // 256 is not a multiple of 32, so the last 8 values of a byte would be drawn slightly more
  // often; masking to 5 bits keeps every character equally likely.
  return Array.from(bytes, (byte) => alphabet[byte & 31]).join("");
}

/** The four feeds a `DataSource` connects to, in the order the wizard offers them (MF-35). */
export const DATA_SOURCE_TYPES = ["mqtt", "http", "websocket", "gtfs-rt"] as const;

export type TypedDataSourceType = (typeof DATA_SOURCE_TYPES)[number];

export type DataSourceType = TypedDataSourceType | string;

export function isTypedDataSource(type: string): type is TypedDataSourceType {
  return (DATA_SOURCE_TYPES as readonly string[]).includes(type);
}

/** The connection block each type carries, keyed the way the manifest keys it. */
export const CONNECTION_BLOCK: Record<TypedDataSourceType, string> = {
  mqtt: "mqtt",
  http: "http",
  websocket: "webSocket",
  "gtfs-rt": "gtfsRt",
};

/**
 * A credential reference, never a credential: the picker offers the secret names this project
 * already uses and takes a new one as free text, and the value itself is only ever in the
 * secret store (CC-06, MF-35).
 */
function secretRef(t: (key: string) => string, title: string, secrets: string[]): JsonSchema {
  return {
    type: "object",
    title,
    required: ["name", "key"],
    properties: {
      name: {
        type: "string",
        title: t("datasources.field.secretName"),
        ...(secrets.length > 0 ? { examples: secrets } : {}),
      },
      key: { type: "string", title: t("datasources.field.secretKey") },
    },
  };
}

/**
 * The form of one connection type (MF-35, UI-04).
 *
 * One schema per type rather than one schema with four optional blocks: the manifest allows
 * exactly the block its `type` names, and a form offering the other three invites a manifest
 * the API refuses.
 */
export function dataSourceSchema(
  t: (key: string) => string,
  type: TypedDataSourceType,
  secrets: string[] = [],
): JsonSchema {
  const name: JsonSchema = {
    type: "string",
    title: t("datasources.field.name"),
    pattern: DNS1123,
    maxLength: 63,
  };
  const title = titleProperty(t("datasources.field.title"));
  const tls: JsonSchema = {
    type: "object",
    title: t("datasources.field.tls"),
    properties: {
      caCertRef: secretRef(t, t("datasources.field.caCert"), secrets),
    },
  };

  const connection: Record<TypedDataSourceType, JsonSchema> = {
    mqtt: {
      type: "object",
      title: t("datasources.type.mqtt"),
      required: ["urls", "topics"],
      properties: {
        urls: {
          type: "array",
          title: t("datasources.field.urls"),
          minItems: 1,
          items: { type: "string", pattern: "^(tcp|tls|ws|wss)://.+" },
        },
        topics: {
          type: "array",
          title: t("datasources.field.topics"),
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        qos: { type: "integer", title: t("datasources.field.qos"), minimum: 0, maximum: 2 },
        cleanSession: { type: "boolean", title: t("datasources.field.cleanSession") },
        username: { type: "string", title: t("datasources.field.username") },
        passwordRef: secretRef(t, t("datasources.field.password"), secrets),
      },
    },
    http: {
      type: "object",
      title: t("datasources.type.http"),
      required: ["url"],
      properties: {
        url: { type: "string", title: t("datasources.field.url"), pattern: "^https?://.+" },
        verb: { type: "string", title: t("datasources.field.verb"), enum: ["GET", "POST"], default: "GET" },
        timeout: { type: "string", title: t("datasources.field.timeout"), pattern: "^[0-9]+(ms|s|m)$" },
        authorization: {
          type: "object",
          title: t("datasources.field.authorization"),
          properties: {
            // No default: a default would put an `authorization` block with a scheme and no
            // credential into every HTTP source, which the API refuses (`headerRef` missing).
            // The API writes `Bearer` in front of a credential when no scheme is named.
            scheme: { type: "string", title: t("datasources.field.scheme") },
            headerRef: secretRef(t, t("datasources.field.credential"), secrets),
          },
        },
      },
    },
    websocket: {
      type: "object",
      title: t("datasources.type.websocket"),
      required: ["url"],
      properties: {
        url: { type: "string", title: t("datasources.field.url"), pattern: "^wss?://.+" },
        openMessage: { type: "string", title: t("datasources.field.openMessage") },
      },
    },
    "gtfs-rt": {
      type: "object",
      title: t("datasources.type.gtfs-rt"),
      required: ["url", "feed"],
      properties: {
        url: { type: "string", title: t("datasources.field.url"), pattern: "^https?://.+" },
        feed: {
          type: "string",
          title: t("datasources.field.feed"),
          enum: ["vehiclePositions", "tripUpdates", "alerts"],
          default: "vehiclePositions",
        },
      },
    },
  };

  return {
    type: "object",
    required: ["name", CONNECTION_BLOCK[type]],
    properties: {
      name,
      title,
      [CONNECTION_BLOCK[type]]: connection[type],
      tls,
    },
  };
}

/** Long free text gets a text area; the rest is default rendering. */
export const dataSourceUiSchema: UiSchema = {
  webSocket: { openMessage: { "ui:widget": "textarea" } },
};

/** Where a sync source reads from (MF-27): one of the three, chosen before the form opens. */
export const SYNC_ORIGINS = ["git", "bundle", "platformApi"] as const;
export type SyncOriginKind = (typeof SYNC_ORIGINS)[number];

/**
 * `SyncSourceSpec` of jc-core as a form (MF-27, MF-28, MF-23): the origin the person chose,
 * the schedule the run follows, and the three decisions an import makes about what it finds.
 */
export function syncSourceSchema(
  t: (key: string) => string,
  origin: SyncOriginKind,
  secrets: string[] = [],
): JsonSchema {
  const origins: Record<SyncOriginKind, JsonSchema> = {
    git: {
      type: "object",
      title: t("syncSources.originKind.git"),
      required: ["url", "ref"],
      properties: {
        url: { type: "string", title: t("syncSources.field.url"), pattern: "^(https://|ssh://|git@).+" },
        ref: { type: "string", title: t("syncSources.field.ref"), default: "main" },
        path: { type: "string", title: t("syncSources.field.path") },
        secretRef: secretRef(t, t("syncSources.field.credential"), secrets),
      },
    },
    bundle: {
      type: "object",
      title: t("syncSources.originKind.bundle"),
      required: ["url"],
      properties: {
        url: { type: "string", title: t("syncSources.field.bundleUrl"), pattern: "^https://.+" },
        secretRef: secretRef(t, t("syncSources.field.credential"), secrets),
      },
    },
    platformApi: {
      type: "object",
      title: t("syncSources.originKind.platformApi"),
      required: ["baseUrl", "project"],
      properties: {
        baseUrl: { type: "string", title: t("syncSources.field.baseUrl"), pattern: "^https://.+" },
        project: { type: "string", title: t("syncSources.field.remoteProject") },
        secretRef: secretRef(t, t("syncSources.field.credential"), secrets),
      },
    },
  };

  return {
    type: "object",
    required: ["name", origin, "interval", "mode", "conflictPolicy"],
    properties: {
      name: { type: "string", title: t("syncSources.field.name"), pattern: DNS1123, maxLength: 63 },
      title: titleProperty(t("syncSources.field.title")),
      [origin]: origins[origin],
      interval: {
        type: "string",
        title: t("syncSources.field.interval"),
        pattern: "^[1-9][0-9]*(s|m|h|d)$",
        default: "6h",
      },
      mode: {
        type: "string",
        title: t("syncSources.field.mode"),
        enum: ["mirror", "oneshot"],
        default: "mirror",
      },
      conflictPolicy: {
        type: "string",
        title: t("syncSources.field.conflictPolicy"),
        enum: ["fail", "skip", "replace", "rename"],
        default: "fail",
      },
      // Both put a change through without a person looking at it, which is why CC-70 and CC-19
      // send a source that asks for either into the red lane.
      prune: { type: "boolean", title: t("syncSources.field.prune"), default: false },
      autoMerge: { type: "boolean", title: t("syncSources.field.autoMerge"), default: false },
    },
  };
}

/** Field entry in the trimmed Bento inputs catalog (PL-50). */
export interface CatalogField {
  path: string;
  type: string;
  kind: string;
  secret: boolean;
  advanced: boolean;
  /** The runner documents the field as optional, whatever its default. */
  optional?: boolean;
  default: unknown;
  description: string;
}

/** Bento runner input catalog item (PL-50). */
export interface CatalogInput {
  name: string;
  group: string;
  summary: string;
  fields: CatalogField[];
}

const SCALAR_TYPES: Record<string, "string" | "integer" | "number" | "boolean"> = {
  string: "string",
  int: "integer",
  float: "number",
  bool: "boolean",
};

/**
 * Generates JSON Schema and UiSchema from a runner input's field tree (PL-50).
 *
 * Nested dot paths become nested objects; arrays of objects and free-form objects edit as YAML;
 * secret fields use the `secretRef` widget; advanced fields are ordered last in `ui:order`.
 */
export function runnerInputSchema(input: CatalogInput): { schema: JsonSchema; uiSchema: UiSchema } {
  // ponytail: advanced: true fields are ordered last in ui:order and tagged with ui:options: { advanced: true }. A collapsible fold widget in SchemaForm is a follow-up.
  const schema: JsonSchema = {
    type: "object",
    properties: {},
    required: [],
  };
  const uiSchema: UiSchema = {};

  const containerPaths = new Set<string>();
  for (const f of input.fields) {
    const parts = f.path.split(".");
    for (let i = 1; i < parts.length; i++) {
      containerPaths.add(parts.slice(0, i).join("."));
    }
  }

  function getContainer(pathSegments: string[]): {
    objSchema: JsonSchema;
    objUi: Record<string, unknown>;
  } {
    let currSchema = schema;
    let currUi = uiSchema as Record<string, unknown>;

    for (const seg of pathSegments) {
      if (!currSchema.properties) {
        currSchema.properties = {};
      }
      if (!currSchema.properties[seg]) {
        currSchema.properties[seg] = {
          type: "object",
          properties: {},
          required: [],
        };
      }
      if (!currUi[seg]) {
        currUi[seg] = {};
      }
      currSchema = currSchema.properties[seg] as JsonSchema;
      currUi = currUi[seg] as Record<string, unknown>;
    }
    return { objSchema: currSchema, objUi: currUi };
  }

  for (const f of input.fields) {
    if (containerPaths.has(f.path)) {
      const parts = f.path.split(".");
      const { objSchema, objUi } = getContainer(parts);
      if (f.description) {
        objSchema.description = f.description;
      }
      if (f.advanced) {
        objUi["ui:options"] = {
          ...((objUi["ui:options"] as Record<string, unknown>) || {}),
          advanced: true,
        };
      }
      continue;
    }

    const parts = f.path.split(".");
    const leafKey = parts[parts.length - 1];
    const parentParts = parts.slice(0, -1);
    const { objSchema, objUi } = getContainer(parentParts);

    const propSchema: JsonSchema = {};
    const propUi: Record<string, unknown> = {};

    const scalarType = SCALAR_TYPES[f.type];
    if (f.secret) {
      propSchema.type = "string";
      propUi["ui:widget"] = "secretRef";
    } else if (f.kind === "array" && scalarType) {
      propSchema.type = "array";
      propSchema.items = { type: scalarType };
    } else if (f.kind === "scalar" && scalarType) {
      propSchema.type = scalarType;
    } else {
      propSchema.type = "string";
      propUi["ui:widget"] = "textarea";
    }

    // A YAML-edited field is a string in the form: a list or map default stays the runner's own
    // and is not sent, since `[]` in a string field fails the form's validation.
    const yamlDefault = propSchema.type === "string" && typeof f.default !== "string";
    if (f.default !== null && f.default !== undefined && !yamlDefault) {
      propSchema.default = f.default as JsonSchema["default"];
    }
    if (f.description) {
      propSchema.description = f.description;
    }

    if (f.advanced) {
      propUi["ui:options"] = {
        ...((propUi["ui:options"] as Record<string, unknown>) || {}),
        advanced: true,
      };
    }

    if (!objSchema.properties) {
      objSchema.properties = {};
    }
    objSchema.properties[leafKey] = propSchema;

    if (Object.keys(propUi).length > 0) {
      objUi[leafKey] = propUi;
    }

    // Required is what the runner requires: no default, not advanced, not marked optional.
    if ((f.default === null || f.default === undefined) && !f.advanced && !f.optional) {
      if (!objSchema.required) {
        objSchema.required = [];
      }
      objSchema.required.push(leafKey);
    }
  }

  function applyOrder(
    props: Record<string, JsonSchema> | undefined,
    targetUi: Record<string, unknown>,
    prefix: string
  ) {
    if (!props) return;
    const keys = Object.keys(props);
    if (keys.length === 0) return;

    const nonAdvanced: string[] = [];
    const advanced: string[] = [];

    for (const k of keys) {
      const fieldPath = prefix ? `${prefix}.${k}` : k;
      const f = input.fields.find((field) => field.path === fieldPath);
      const opts = (targetUi[k] as { "ui:options"?: { advanced?: boolean } } | undefined)?.["ui:options"];
      const isAdv = Boolean(f?.advanced || opts?.advanced);
      if (isAdv) {
        advanced.push(k);
      } else {
        nonAdvanced.push(k);
      }

      const childSchema = props[k];
      if (
        childSchema &&
        typeof childSchema === "object" &&
        childSchema.type === "object" &&
        childSchema.properties
      ) {
        targetUi[k] = targetUi[k] || {};
        applyOrder(
          childSchema.properties as Record<string, JsonSchema>,
          targetUi[k] as Record<string, unknown>,
          fieldPath
        );
      }
    }

    targetUi["ui:order"] = [...nonAdvanced, ...advanced, "*"];
  }

  applyOrder(schema.properties as Record<string, JsonSchema>, uiSchema as Record<string, unknown>, "");

  return { schema, uiSchema };
}

/** Prepares envelope-level schema for a runner input by prepending `name` and `title`. */
export function runnerDataSourceSchema(
  t: (key: string) => string,
  input: CatalogInput
): { schema: JsonSchema; uiSchema: UiSchema } {
  const { schema: inputSchema, uiSchema: inputUiSchema } = runnerInputSchema(input);

  const name: JsonSchema = {
    type: "string",
    title: t("datasources.field.name"),
    pattern: DNS1123,
    maxLength: 63,
  };
  const title = titleProperty(t("datasources.field.title"));

  const schema: JsonSchema = {
    type: "object",
    required: ["name", ...(inputSchema.required ?? [])],
    properties: {
      name,
      title,
      ...(inputSchema.properties ?? {}),
    },
  };

  const inputOrder = (inputUiSchema["ui:order"] as string[]) ?? [];
  const uiOrder = ["name", "title", ...inputOrder.filter((k) => k !== "*"), "*"];

  const uiSchema: UiSchema = {
    ...inputUiSchema,
    "ui:order": uiOrder,
  };

  return { schema, uiSchema };
}

/** The field paths a runner input documents as YAML documents (objects, maps, lists of objects). */
export function yamlPathsOf(inputDef?: CatalogInput): Set<string> {
  const paths = new Set<string>();
  for (const f of inputDef?.fields ?? []) {
    const yamlType = f.type === "object" || f.type === "unknown";
    if (f.kind === "map" || ((f.kind === "scalar" || f.kind === "array") && yamlType)) {
      paths.add(f.path);
    }
  }
  return paths;
}

/** A YAML-edited field the form cannot serialise; `field` is the path the runner documents. */
export class YamlFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly detail: string
  ) {
    super(`${field}: not valid YAML: ${detail}`);
  }
}

/**
 * Turns the YAML text a textarea holds back into the object or list the manifest carries.
 * A field the catalog marks as YAML is always parsed; any other string is parsed only when it
 * looks like a document (a newline, or a leading `-`, `{`, `[` or `:`). A parse error throws
 * `YamlFieldError`, so a broken value never reaches the API as a string.
 */
export function parseYamlStrings(val: unknown, yamlPaths: Set<string> = new Set(), path = ""): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (yamlPaths.has(path) || /^[-{[:]/.test(trimmed) || trimmed.includes("\n")) {
      try {
        const parsed = parseYaml(val);
        return typeof parsed === "object" && parsed !== null ? parsed : val;
      } catch (err) {
        throw new YamlFieldError(path, err instanceof Error ? err.message : String(err));
      }
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((v) => parseYamlStrings(v, yamlPaths, path));
  }
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = parseYamlStrings(v, yamlPaths, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return val;
}

/** Finds all `${VAR}` interpolation names across an object. */
export function findEnvVars(obj: unknown, found: Set<string>): void {
  if (typeof obj === "string") {
    const matches = obj.matchAll(/\$\{([A-Z0-9_]+)\}/g);
    for (const m of matches) {
      found.add(m[1]);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      findEnvVars(item, found);
    }
  } else if (obj && typeof obj === "object") {
    for (const val of Object.values(obj)) {
      findEnvVars(val, found);
    }
  }
}

/** The execution classes of a Pipeline, `auto` letting the reconciler pick (PL-04, PL-26). */
export const PIPELINE_CLASSES = ["auto", "resident", "scheduled"] as const;

/** The compute engines a pipeline step may run on, lightest first (PL-33). */
export const COMPUTE_KINDS = ["bloblang", "mapping", "wasm", "container"] as const;

/** How a derived pipeline writes its result (PL-32). */
export const OUTPUT_MODES = ["upsert", "update-attrs"] as const;

/** A Bento duration: a positive count and one of the units Bento accepts (PL-26, PL-27). */
export const PERIOD_PATTERN = "^[1-9][0-9]*(ms|s|m|h)$";

/** Five whitespace-separated fields; the CronJob controller parses the rest (PL-04). */
export const CRON_PATTERN = "^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$";

/** An NGSI-LD entity type short name, PascalCase, 2 to 64 characters. */
export const ENTITY_TYPE_PATTERN = "^[A-Z][A-Za-z0-9]{1,63}$";

/** The URN of an Endpoint: `urn:ngsi-ld:Endpoint:{orgDomain}:{space}:{name}` (PF-39, PL-18). */
export const ENDPOINT_URN_PATTERN = "^urn:ngsi-ld:Endpoint:[^:]+:[^:]+:[^:]+$";

/** One Endpoint the pipeline form may pick, by name as a source and by URN as a target. */
export interface EndpointOption {
  name: string;
  urn?: string;
}

/** A select when the project has something to offer, free text with the pattern otherwise. */
function choice(base: JsonSchema, values: string[]): JsonSchema {
  return values.length > 0 ? { ...base, enum: values } : base;
}

/**
 * `PipelineSpec`, field for field, with the rules `PipelineSpec::validate` checks written as
 * conditions so the form refuses what the reconciler would refuse (PL-04, PL-31, PL-33, PL-39).
 *
 * The mapping of a `bloblang` step is `compute.bloblang` (PL-41), rendered as the last
 * processor of the stream; left empty, the author keeps it in `bento.yaml` beside the manifest.
 */
export function pipelineSchema(
  t: (key: string) => string,
  dataSources: string[],
  endpoints: EndpointOption[],
): JsonSchema {
  const entityType = (title: string): JsonSchema => ({
    type: "string",
    title,
    pattern: ENTITY_TYPE_PATTERN,
  });
  const names = (title: string): JsonSchema => ({
    type: "array",
    title,
    items: { type: "string", minLength: 1 },
  });
  // The option a person picks is the endpoint's name; the value the manifest carries is the
  // URN the organization domain completes (PL-04).
  const targets = endpoints.flatMap((endpoint) =>
    endpoint.urn ? [{ const: endpoint.urn, title: endpoint.name }] : [],
  );

  return {
    type: "object",
    required: ["name", "class", "targetEndpoint"],
    properties: {
      name: {
        type: "string",
        title: t("pipelines.field.id"),
        pattern: DNS1123,
        maxLength: 63,
      },
      title: titleProperty(t("pipelines.field.title")),
      class: {
        type: "string",
        title: t("pipelines.field.class"),
        description: t("pipelines.field.classHint"),
        enum: [...PIPELINE_CLASSES],
        default: "auto",
      },
      schedule: {
        type: "string",
        title: t("pipelines.field.schedule"),
        description: t("pipelines.field.scheduleHint"),
        pattern: CRON_PATTERN,
      },
      period: {
        type: "string",
        title: t("pipelines.field.period"),
        description: t("pipelines.field.periodHint"),
        pattern: PERIOD_PATTERN,
      },
      source: {
        type: "object",
        title: t("pipelines.field.source"),
        description: t("pipelines.field.sourceHint"),
        properties: {
          dataSourceRef: choice(
            { type: "string", title: t("pipelines.field.dataSource"), pattern: DNS1123 },
            dataSources,
          ),
          endpointRef: choice(
            { type: "string", title: t("pipelines.field.sourceEndpoint"), pattern: DNS1123 },
            endpoints.map((endpoint) => endpoint.name),
          ),
          query: {
            type: "object",
            title: t("pipelines.field.query"),
            properties: {
              type: entityType(t("pipelines.field.queryType")),
              attrs: names(t("pipelines.field.attrs")),
              // The ticked entities of the studio's sample (PL-42): PF-42 URNs.
              ids: {
                type: "array",
                title: t("pipelines.field.ids"),
                description: t("pipelines.field.idsHint"),
                items: { type: "string", pattern: "^urn:ngsi-ld:[^:]+:[^:]+:[^:]+:[A-Za-z0-9._~-]{1,128}$" },
              },
              q: { type: "string", title: t("pipelines.field.q") },
              scopeQ: { type: "string", title: t("pipelines.field.scopeQ") },
              geoQ: { type: "string", title: t("pipelines.field.geoQ") },
              temporalQ: {
                type: "object",
                title: t("pipelines.field.temporalQ"),
                properties: {
                  window: {
                    type: "string",
                    title: t("pipelines.field.temporalWindow"),
                    pattern: "^P",
                  },
                },
              },
            },
          },
          trigger: {
            type: "object",
            title: t("pipelines.field.trigger"),
            properties: {
              subscription: {
                type: "object",
                title: t("pipelines.field.subscription"),
                properties: {
                  type: entityType(t("pipelines.field.triggerType")),
                  watchedAttributes: names(t("pipelines.field.watchedAttributes")),
                },
                // A subscription is its type; attributes alone name nothing to watch.
                dependencies: { watchedAttributes: ["type"] },
              },
            },
          },
        },
        // One input: the outside world through a DataSource or the platform's own spaces
        // through an Endpoint, never both (PL-39).
        not: { required: ["dataSourceRef", "endpointRef"] },
      },
      compute: {
        type: "object",
        title: t("pipelines.field.compute"),
        description: t("pipelines.field.computeHint"),
        properties: {
          kind: {
            type: "string",
            title: t("pipelines.field.computeKind"),
            enum: [...COMPUTE_KINDS],
          },
          module: { type: "string", title: t("pipelines.field.module") },
          function: { type: "string", title: t("pipelines.field.function") },
          mappingRef: { type: "string", title: t("pipelines.field.mappingRef"), pattern: DNS1123 },
          bloblang: {
            type: "string",
            title: t("pipelines.field.bloblang"),
            description: t("pipelines.field.bloblangHint"),
          },
        },
        dependencies: { module: ["kind"], function: ["kind"], mappingRef: ["kind"], bloblang: ["kind"] },
        allOf: [
          {
            // The inline mapping belongs to a bloblang step only (PL-41).
            if: { required: ["bloblang"] },
            then: { properties: { kind: { const: "bloblang" } }, required: ["kind"] },
          },
          {
            if: { properties: { kind: { const: "wasm" } }, required: ["kind"] },
            then: { required: ["module", "function"] },
          },
          {
            if: { properties: { kind: { const: "mapping" } }, required: ["kind"] },
            then: {
              required: ["mappingRef"],
              not: { anyOf: [{ required: ["module"] }, { required: ["function"] }] },
            },
          },
        ],
      },
      targetEndpoint: {
        type: "string",
        title: t("pipelines.field.targetEndpoint"),
        description: t("pipelines.field.targetEndpointHint"),
        ...(targets.length > 0 ? { oneOf: targets } : { pattern: ENDPOINT_URN_PATTERN }),
      },
      output: {
        type: "object",
        title: t("pipelines.field.output"),
        properties: {
          type: entityType(t("pipelines.field.outputType")),
          mode: {
            type: "string",
            title: t("pipelines.field.outputMode"),
            enum: [...OUTPUT_MODES],
          },
        },
        // The manifest takes both or neither.
        dependencies: { type: ["mode"], mode: ["type"] },
      },
      allowFeedback: {
        type: "boolean",
        title: t("pipelines.field.allowFeedback"),
        description: t("pipelines.field.allowFeedbackHint"),
      },
      secretRefs: {
        type: "array",
        title: t("pipelines.field.secrets"),
        description: t("pipelines.field.secretsHint"),
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", title: t("pipelines.field.secretName"), pattern: DNS1123 },
            key: { type: "string", title: t("pipelines.field.secretKey") },
            envVar: { type: "string", title: t("pipelines.field.envVar"), pattern: "^[A-Z_][A-Z0-9_]*$" },
          },
        },
      },
      quotas: {
        type: "object",
        title: t("pipelines.field.quotas"),
        properties: {
          maxMemoryMb: { type: "integer", title: t("pipelines.field.maxMemoryMb"), minimum: 1 },
          cpuMillicores: { type: "integer", title: t("pipelines.field.cpuMillicores"), minimum: 1 },
        },
      },
    },
    allOf: [
      {
        if: { properties: { class: { const: "scheduled" } }, required: ["class"] },
        then: { required: ["schedule"] },
      },
      {
        if: { properties: { class: { const: "resident" } }, required: ["class"] },
        then: { not: { required: ["schedule"] } },
      },
    ],
  };
}

/** The manifest's own order, so the form reads like the YAML it writes. */
export const pipelineUiSchema: UiSchema = {
  "ui:order": [
    "name",
    "title",
    "class",
    "schedule",
    "period",
    "source",
    "compute",
    "targetEndpoint",
    "output",
    "allowFeedback",
    "secretRefs",
    "quotas",
    "*",
  ],
  source: { "ui:order": ["dataSourceRef", "endpointRef", "query", "trigger", "*"] },
  compute: {
    "ui:order": ["kind", "bloblang", "mappingRef", "module", "function", "*"],
    bloblang: { "ui:widget": "textarea", "ui:options": { rows: 14 } },
  },
};

// ---------------------------------------------------------------------------------------------
// Dashboards and layers (T-0528, UI-17, UI-18): `DashboardSpec` and `LayerSpec` of jc-core.

export const DASHBOARD_VISIBILITIES = ["private", "project", "organization", "public"] as const;
export const PAGE_LAYOUTS = ["full-map", "grid-2x2"] as const;
export const LAYER_STYLES = ["circle", "line", "fill", "heatmap", "hexagon", "icon"] as const;

const numberPair = (title: string): JsonSchema => ({
  type: "array",
  title,
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
});

/** The widget types the Portal draws (UI-18): a `grid` reads a type, a chart reads one property. */
export const WIDGET_TYPES = ["temporal-chart", "grid"] as const;

/**
 * The grid's own configuration as a widget carries it (UI-71, SDK-30, T-1440): the schema the SDK
 * publishes, without the fields that name a source. `source` and `type` are the widget's own
 * `endpointRef` and `entityType`; `compareWith` names a *second* endpoint or space, which a
 * dashboard manifest may not do either — and `jc_core::kinds::grid::GridConfig` refuses it with
 * `deny_unknown_fields`, so a form offering it would draw a manifest the platform rejects.
 */
const NOT_THE_MANIFESTS_TO_NAME = ["source", "type", "compareWith"];

function gridWidgetSchema(t: (key: string) => string): JsonSchema {
  const published = gridConfigSchema as unknown as {
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  const kept = Object.fromEntries(
    Object.entries(published.properties).filter(
      ([name]) => !NOT_THE_MANIFESTS_TO_NAME.includes(name),
    ),
  );
  return {
    type: "object",
    title: t("dashboards.field.grid"),
    additionalProperties: published.additionalProperties ?? false,
    properties: kept,
  } as JsonSchema;
}

export function dashboardSchema(
  t: (key: string) => string,
  layers: string[],
  types: string[] = [],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "title", "visibility", "pages"],
    properties: {
      name: { type: "string", title: t("dashboards.field.name"), pattern: DNS1123, maxLength: 63 },
      title: titleProperty(t("dashboards.field.title")),
      visibility: {
        type: "string",
        title: t("dashboards.field.visibility"),
        enum: [...DASHBOARD_VISIBILITIES],
        default: "project",
      },
      pages: {
        type: "array",
        title: t("dashboards.field.pages"),
        minItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string", title: t("dashboards.field.pageTitle") },
            layout: {
              type: "string",
              title: t("dashboards.field.layout"),
              enum: [...PAGE_LAYOUTS],
              default: "full-map",
            },
            layers: {
              type: "array",
              title: t("dashboards.field.layers"),
              items: layers.length > 0 ? { type: "string", enum: layers } : { type: "string", pattern: DNS1123 },
              uniqueItems: true,
            },
            widgets: {
              type: "array",
              title: t("dashboards.field.widgets"),
              items: {
                type: "object",
                required: ["widgetType"],
                properties: {
                  // The two the Portal draws (UI-18, T-1440): a widget type it cannot draw would
                  // be committed and then say "unsupported" on the page.
                  widgetType: {
                    type: "string",
                    title: t("dashboards.field.widgetType"),
                    enum: [...WIDGET_TYPES],
                    default: "temporal-chart",
                  },
                  endpointRef: { type: "string", title: t("dashboards.field.endpoint"), pattern: DNS1123 },
                  entityId: { type: "string", title: t("dashboards.field.entityId") },
                  property: { type: "string", title: t("dashboards.field.property") },
                  entityType: {
                    type: "string",
                    title: t("dashboards.field.entityType"),
                    ...(types.length > 0 ? { enum: types } : { pattern: ENTITY_TYPE_PATTERN }),
                  },
                  grid: gridWidgetSchema(t),
                },
              },
            },
          },
        },
      },
    },
  };
}

export const dashboardUiSchema: UiSchema = {
  pages: { items: { layers: { "ui:widget": "checkboxes" } } },
};

export function layerSchema(
  t: (key: string) => string,
  endpoints: string[],
  types: string[],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "sourceEndpointRef", "entityType", "style"],
    properties: {
      name: { type: "string", title: t("dashboards.field.name"), pattern: DNS1123, maxLength: 63 },
      sourceEndpointRef: {
        type: "string",
        title: t("dashboards.field.endpoint"),
        ...(endpoints.length > 0 ? { enum: endpoints } : { pattern: DNS1123 }),
      },
      entityType: {
        type: "string",
        title: t("dashboards.field.entityType"),
        ...(types.length > 0 ? { enum: types } : { pattern: ENTITY_TYPE_PATTERN }),
      },
      style: { type: "string", title: t("dashboards.field.style"), enum: [...LAYER_STYLES], default: "circle" },
      visible: { type: "boolean", title: t("dashboards.field.visible"), default: true },
      filter: {
        type: "object",
        title: t("dashboards.field.filter"),
        properties: {
          q: { type: "string", title: "q" },
          scopeQ: { type: "string", title: "scopeQ" },
          geoQ: { type: "string", title: "geoQ" },
        },
      },
      colorBy: {
        type: "object",
        title: t("dashboards.field.colorBy"),
        properties: {
          property: { type: "string", title: t("dashboards.field.property") },
          palette: { type: "string", title: t("dashboards.field.palette") },
          domain: numberPair(t("dashboards.field.domain")),
        },
      },
      sizeBy: {
        type: "object",
        title: t("dashboards.field.sizeBy"),
        properties: {
          property: { type: "string", title: t("dashboards.field.property") },
          range: numberPair(t("dashboards.field.range")),
        },
      },
      popupProperties: {
        type: "array",
        title: t("dashboards.field.popup"),
        items: { type: "string" },
        uniqueItems: true,
      },
    },
  };
}

export const layerUiSchema: UiSchema = {
  filter: { q: { "ui:autocomplete": "off" } },
};

/**
 * What the operations field offers: the five CIM 009 group names, then the operations those
 * groups are made of (T-2282, GW34).
 *
 * Derived, never retyped: the member lists live in `components/endpoints/operationGroups`, which
 * is held against Table 4.20-2 by `part_operation_groups.test.tsx` and by jc-core. A policy that
 * already grants an operation outside this list — a manifest written by hand — keeps it: the page
 * passes what the stored manifest carries, so the form opens every policy the API accepted.
 */
export const OPERATION_CHOICES: string[] = [
  ...OPERATION_GROUP_NAMES,
  ...expandOperations(OPERATION_GROUP_NAMES).sort((a, b) => a.localeCompare(b)),
];

/** How a policy reads: a grant, or a refusal that is evaluated before every grant (GW4, GW8). */
export const POLICY_EFFECTS = ["permission", "prohibition"] as const;

/** Who a policy is granted to, in the order a person thinks of them (PF-40, R5). */
export const PRINCIPAL_KINDS = ["role", "group", "user", "serviceAccount", "did"] as const;

/**
 * The `Policy` a person authors: the space, the grantee, the operations, the entities and the
 * residual filters (R5…R9, GW34, UI-01).
 *
 * `assigner` is not a field: it is the data owner, which is the organization the project belongs
 * to, and the page fills it from the Organization manifest. `operations` is a list of names —
 * the five CIM 009 groups and the individual operations they stand for — rendered by the
 * `operations` widget rather than as forty checkboxes; the names themselves come from
 * `components/endpoints/operationGroups`, never from a list retyped here (T-2282, T-2326).
 */
export function policySchema(
  t: (key: string) => string,
  spaces: string[] = [],
  types: string[] = [],
  granted: string[] = [],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "contextSpaceRef", "assignee", "operations"],
    properties: {
      name: {
        type: "string",
        title: t("policies.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      contextSpaceRef: {
        type: "string",
        title: t("policies.field.space"),
        ...(spaces.length > 0 ? { enum: spaces } : { pattern: DNS1123 }),
      },
      effect: {
        type: "string",
        title: t("policies.field.effect"),
        enum: [...POLICY_EFFECTS],
        default: "permission",
      },
      assignee: {
        type: "object",
        title: t("policies.field.assignee"),
        required: ["kind", "id"],
        properties: {
          kind: {
            type: "string",
            title: t("policies.field.assigneeKind"),
            enum: [...PRINCIPAL_KINDS],
            default: "role",
          },
          id: { type: "string", title: t("policies.field.assigneeId"), maxLength: 253 },
        },
      },
      operations: {
        type: "array",
        title: t("policies.field.operations"),
        // A list of choices rather than of free text: rjsf hands a multiple-choice array to the
        // picker, and a name outside the vocabulary is refused here as the API refuses it (GW34).
        items: {
          type: "string",
          enum: [...new Set([...OPERATION_CHOICES, ...granted])],
        },
        uniqueItems: true,
        minItems: 1,
        default: ["retrieveOps"],
      },
      information: {
        type: "array",
        title: t("policies.field.information"),
        items: {
          type: "object",
          required: ["entities"],
          properties: {
            entities: {
              type: "array",
              title: t("policies.field.entities"),
              minItems: 1,
              items: {
                type: "object",
                required: ["type"],
                properties: {
                  type: {
                    type: "string",
                    title: t("policies.field.entityType"),
                    ...(types.length > 0
                      ? { enum: types }
                      : { pattern: ENTITY_TYPE_PATTERN }),
                  },
                  idPattern: { type: "string", title: t("policies.field.idPattern") },
                },
              },
            },
            propertyNames: {
              type: "array",
              title: t("policies.field.propertyNames"),
              items: { type: "string" },
              uniqueItems: true,
            },
            relationshipNames: {
              type: "array",
              title: t("policies.field.relationshipNames"),
              items: { type: "string" },
              uniqueItems: true,
            },
          },
        },
      },
      q: { type: "string", title: "q" },
      scopeQ: { type: "string", title: "scopeQ" },
      geoQ: { type: "string", title: "geoQ" },
      temporalQ: { type: "string", title: "temporalQ" },
      validity: {
        type: "object",
        title: t("policies.field.validity"),
        properties: {
          from: { type: "string", title: t("policies.field.validFrom") },
          to: { type: "string", title: t("policies.field.validTo") },
        },
      },
    },
  };
}

/**
 * The operations picker instead of a list of text boxes, and no autocomplete on the four filter
 * expressions: a browser offering a previous `q` on another space's policy is a suggestion that
 * grants something nobody read.
 */
export const policyUiSchema: UiSchema = {
  operations: { "ui:widget": "operations" },
  q: { "ui:autocomplete": "off" },
  scopeQ: { "ui:autocomplete": "off" },
  geoQ: { "ui:autocomplete": "off" },
  temporalQ: { "ui:autocomplete": "off" },
};

/** The verbs a rule may grant, as `jc-core`'s `Verb` spells them (PF-49). */
export const ROLE_VERBS = ["read", "propose", "approve", "delete"] as const;

/** A manifest kind is written as the manifest writes it: `Pipeline`, not `pipeline` (PF-49). */
export const KIND_PATTERN = "^[A-Z][A-Za-z0-9]{1,63}$";

/**
 * The `Role` a person authors: a list of rules, each a set of verbs on a set of kinds
 * (PF-49, PF-52, PF-68).
 *
 * `kinds` and `verbs` are offered as the caller's own rights, never as the whole catalogue:
 * nobody grants above what they hold, and a list that offers `approve` to somebody who cannot
 * approve is a form that walks a person into a refusal (PF-52). With no permissions document yet
 * — a fresh pod, or a bootstrap administrator — both fall back to free text under the pattern the
 * API validates, because the UI is never the point of enforcement (PF-51).
 *
 * `constraints` is not a field. A rule that carries them keeps them: the page passes the stored
 * manifest through, and the YAML view is where they are written.
 */
export function roleSchema(
  t: (key: string) => string,
  kinds: string[] = [],
  verbs: readonly string[] = ROLE_VERBS,
): JsonSchema {
  return {
    type: "object",
    required: ["name", "rules"],
    properties: {
      name: {
        type: "string",
        title: t("access.projectRoles.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      rules: {
        type: "array",
        title: t("access.projectRoles.field.rules"),
        minItems: 1,
        items: {
          type: "object",
          required: ["kinds", "verbs"],
          properties: {
            kinds: {
              type: "array",
              title: t("access.projectRoles.field.kinds"),
              minItems: 1,
              uniqueItems: true,
              items: {
                type: "string",
                ...(kinds.length > 0 ? { enum: kinds } : { pattern: KIND_PATTERN }),
              },
            },
            verbs: {
              type: "array",
              title: t("access.projectRoles.field.verbs"),
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", enum: [...verbs] },
            },
          },
        },
      },
    },
  };
}

/**
 * An address is `local@domain.tld`, the name Keycloak carries a person under (PF-04, PF-62).
 *
 * Wider than `jc-core`'s `is_address` on purpose: a pattern that refused an address the API
 * accepts would keep a colleague out of a group, and the API is what decides (PF-51).
 */
export const MEMBER_ADDRESS_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

/**
 * The `Group` a person authors: what the group is, and who is in it (PF-62).
 *
 * `members` are addresses. Offered as a list of the people the organization already knows where
 * the page has them, and as free text otherwise, because somebody who has never signed in is
 * still a member a binding may name — the reconciler waits for their first login and says so.
 */
export function groupSchema(t: (key: string) => string, users: string[] = []): JsonSchema {
  return {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        title: t("access.groups.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      description: {
        type: "string",
        title: t("access.groups.field.description"),
        maxLength: 512,
      },
      members: {
        type: "array",
        title: t("access.groups.field.members"),
        uniqueItems: true,
        items: {
          type: "object",
          required: ["user"],
          properties: {
            user: {
              type: "string",
              title: t("access.groups.field.memberUser"),
              maxLength: 253,
              ...(users.length > 0 ? { examples: users } : {}),
              pattern: MEMBER_ADDRESS_PATTERN,
            },
          },
        },
      },
    },
  };
}

/** The three notification formats CIM 009 clause 5.2.14 names; absent means the broker's own. */
export const NOTIFICATION_FORMATS = ["normalized", "concise", "keyValues"] as const;

/**
 * An address a notification may be posted to: `http` or `https`, a host, and no `user@` in it.
 * jc-core refuses the same three things (`NotificationEndpoint::validate`), and a credential in
 * the query is refused there too; the form catches the shape before a round trip does.
 */
export const NOTIFICATION_URI_PATTERN = "^https?://[^\\s/?#@]+([/?#]\\S*)?$";

/** Header names whose value is a credential, as jc-core's `CREDENTIAL_HEADERS` lists them. */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];

/**
 * A header name, and never one of those: their value belongs in `secretRef` (MF-31). A schema
 * pattern takes no `i` flag, so each letter is spelled in both cases.
 */
export const HEADER_NAME_PATTERN = `^(?!(${CREDENTIAL_HEADERS.map((name) =>
  name.replace(/[a-z]/g, (letter) => `[${letter.toUpperCase()}${letter}]`),
).join("|")})$)[A-Za-z0-9-]+$`;

/** An RFC 3339 moment with its offset, as `expiresAt` is written into the manifest. */
export const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$";

/**
 * The `Subscription` a person authors: which space, what is watched, where the notification goes
 * and how often (CC-72, DS-16, CIM 009 clause 5.2.12).
 *
 * The shape is the manifest's, member for member, so the YAML view and the fields agree; only
 * `contextSpaceRef` is a name here and a reference there. A selector names a type, an id or an
 * id pattern (`minProperties`, since rjsf drops an emptied text box), and the credential the
 * receiver needs is a `secretRef`, never a header value: `Authorization`, `Cookie` and
 * `Proxy-Authorization` are refused in `receiverInfo` by jc-core, and the form says why at the
 * field rather than after the Check (MF-31, PF-36).
 */
export function subscriptionSchema(
  t: (key: string) => string,
  spaces: string[] = [],
  secrets: string[] = [],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "contextSpaceRef", "notification"],
    properties: {
      name: {
        type: "string",
        title: t("subscriptions.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      subscriptionName: {
        type: "string",
        title: t("subscriptions.field.subscriptionName"),
        maxLength: 256,
      },
      contextSpaceRef: {
        type: "string",
        title: t("subscriptions.field.space"),
        ...(spaces.length > 0 ? { enum: spaces } : { pattern: DNS1123 }),
      },
      description: {
        type: "string",
        title: t("subscriptions.field.description"),
        maxLength: 1024,
      },
      entities: {
        type: "array",
        title: t("subscriptions.field.entities"),
        items: {
          type: "object",
          minProperties: 1,
          properties: {
            type: {
              type: "string",
              title: t("subscriptions.field.entityType"),
              pattern: ENTITY_TYPE_PATTERN,
            },
            id: {
              type: "string",
              title: t("subscriptions.field.entityId"),
              pattern: "^urn:ngsi-ld:\\S+$",
            },
            idPattern: { type: "string", title: t("subscriptions.field.idPattern") },
          },
        },
      },
      watchedAttributes: {
        type: "array",
        title: t("subscriptions.field.watchedAttributes"),
        items: { type: "string", pattern: "^\\S+$" },
        uniqueItems: true,
      },
      q: { type: "string", title: "q" },
      geoQ: { type: "string", title: "geoQ" },
      notification: {
        type: "object",
        title: t("subscriptions.field.notification"),
        required: ["endpoint"],
        properties: {
          endpoint: {
            type: "object",
            title: t("subscriptions.field.endpoint"),
            required: ["uri"],
            properties: {
              uri: {
                type: "string",
                title: t("subscriptions.field.uri"),
                pattern: NOTIFICATION_URI_PATTERN,
                maxLength: 2048,
              },
              accept: {
                type: "string",
                title: t("subscriptions.field.accept"),
                enum: ["application/json", "application/ld+json", "application/geo+json"],
              },
              receiverInfo: {
                type: "array",
                title: t("subscriptions.field.receiverInfo"),
                items: {
                  type: "object",
                  required: ["key", "value"],
                  properties: {
                    key: {
                      type: "string",
                      title: t("subscriptions.field.headerName"),
                      pattern: HEADER_NAME_PATTERN,
                    },
                    value: { type: "string", title: t("subscriptions.field.headerValue") },
                  },
                },
              },
              secretRef: secretRef(t, t("subscriptions.field.secretRef"), secrets),
            },
          },
          format: {
            type: "string",
            title: t("subscriptions.field.format"),
            enum: [...NOTIFICATION_FORMATS],
          },
          attributes: {
            type: "array",
            title: t("subscriptions.field.attributes"),
            items: { type: "string", pattern: "^\\S+$" },
            uniqueItems: true,
          },
        },
      },
      throttling: {
        type: "integer",
        title: t("subscriptions.field.throttling"),
        minimum: 1,
      },
      expiresAt: {
        type: "string",
        title: t("subscriptions.field.expiresAt"),
        pattern: RFC3339_PATTERN,
      },
      isActive: {
        type: "boolean",
        title: t("subscriptions.field.isActive"),
        default: true,
      },
    },
  };
}

/** No autocomplete on the two filter expressions, for the reason `policyUiSchema` gives. */
export const subscriptionUiSchema: UiSchema = {
  q: { "ui:autocomplete": "off" },
  geoQ: { "ui:autocomplete": "off" },
};

/** What a service account's grant covers, in the order a person narrows it (PF-35). */
export const ROLE_SCOPE_LEVELS = ["project", "contextSpace", "organization"] as const;

/** How a workload proves itself: a Keycloak client first, a hashed key only for a legacy caller (PF-37). */
export const CREDENTIAL_KINDS = ["oauth-client", "api-key"] as const;

/** An IPv4 or IPv6 block with its prefix length, as jc-core's `validate_cidr` reads one. */
export const CIDR_PATTERN = "^[0-9A-Fa-f:.]+/[0-9]{1,3}$";

/**
 * The `ServiceAccount` a person authors: who answers for it, why it exists, what it may do and
 * how it signs in (PF-34, PF-35, PF-36, PF-47).
 *
 * A credential is declared, never held: `kind` and `name` say which client or key exists, and
 * the value lives in Keycloak or as an Argon2id hash in the Portal's database, so the form has no
 * field a secret could be typed into (PF-36). A grant's scope is one of three levels in the
 * manifest and one choice and one name here: jc-core refuses a scope naming two, and a form with
 * three optional boxes invites exactly that (`spec.roles.scope`).
 */
export function serviceAccountSchema(
  t: (key: string) => string,
  spaces: string[] = [],
  granted: string[] = [],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "purpose", "owner", "roles", "credentials"],
    properties: {
      name: {
        type: "string",
        title: t("access.accounts.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      purpose: {
        type: "string",
        title: t("access.accounts.field.purpose"),
        minLength: 1,
        maxLength: 1024,
      },
      owner: {
        type: "object",
        title: t("access.accounts.field.owner"),
        required: ["user"],
        properties: {
          user: {
            type: "string",
            title: t("access.accounts.field.ownerUser"),
            minLength: 1,
            maxLength: 253,
          },
        },
      },
      roles: {
        type: "array",
        title: t("access.accounts.field.roles"),
        minItems: 1,
        items: {
          type: "object",
          required: ["role", "scope"],
          properties: {
            role: {
              type: "string",
              title: t("access.accounts.field.role"),
              pattern: DNS1123,
              maxLength: 63,
            },
            scope: {
              type: "object",
              title: t("access.accounts.field.scope"),
              required: ["level", "name"],
              properties: {
                level: {
                  type: "string",
                  title: t("access.accounts.field.scopeLevel"),
                  enum: [...ROLE_SCOPE_LEVELS],
                  default: "project",
                },
                name: {
                  type: "string",
                  title: t("access.accounts.field.scopeName"),
                  pattern: DNS1123,
                  ...(spaces.length > 0 ? { examples: spaces } : {}),
                },
              },
            },
            operations: {
              type: "array",
              title: t("access.accounts.field.operations"),
              items: {
                type: "string",
                enum: [...new Set([...OPERATION_CHOICES, ...granted])],
              },
              uniqueItems: true,
            },
            types: {
              type: "array",
              title: t("access.accounts.field.types"),
              items: { type: "string", pattern: ENTITY_TYPE_PATTERN },
              uniqueItems: true,
            },
          },
        },
      },
      credentials: {
        type: "array",
        title: t("access.accounts.field.credentials"),
        minItems: 1,
        items: {
          type: "object",
          required: ["kind", "name"],
          properties: {
            kind: {
              type: "string",
              title: t("access.accounts.field.credentialKind"),
              enum: [...CREDENTIAL_KINDS],
              default: "oauth-client",
            },
            name: {
              type: "string",
              title: t("access.accounts.field.credentialName"),
              pattern: DNS1123,
              maxLength: 63,
            },
            expiresAt: {
              type: "string",
              title: t("access.accounts.field.expiresAt"),
              pattern: RFC3339_PATTERN,
            },
            ipAllowList: {
              type: "array",
              title: t("access.accounts.field.ipAllowList"),
              items: { type: "string", pattern: CIDR_PATTERN },
              uniqueItems: true,
            },
          },
        },
      },
      limits: {
        type: "object",
        title: t("access.accounts.field.limits"),
        properties: {
          requestsPerMinute: {
            type: "integer",
            title: t("access.accounts.field.requestsPerMinute"),
            minimum: 1,
          },
        },
      },
      workload: {
        type: "object",
        title: t("access.accounts.field.workload"),
        properties: {
          kubernetes: {
            type: "object",
            title: t("access.accounts.field.kubernetes"),
            required: ["namespace", "serviceAccount"],
            properties: {
              namespace: {
                type: "string",
                title: t("access.accounts.field.k8sNamespace"),
                pattern: DNS1123,
              },
              serviceAccount: {
                type: "string",
                title: t("access.accounts.field.k8sServiceAccount"),
                pattern: DNS1123,
              },
            },
          },
        },
      },
    },
  };
}

/** The operations picker for each grant, as the Policy form has it (T-2282). */
export const serviceAccountUiSchema: UiSchema = {
  roles: { items: { operations: { "ui:widget": "operations" } } },
};

/** How an app is built and served (AP-01), as jc-core's `AppClass` spells it. */
export const APP_CLASSES = ["static", "service", "fullstack"] as const;

/** Who may reach a published app (AP-18), narrowest first. */
export const APP_VISIBILITIES = ["private", "project", "organization", "public"] as const;

/** Where an app's source lives: exactly one of the two (AP-02). */
export const APP_SOURCES = ["path", "git"] as const;

/** Every representation an Endpoint may serve (EP-05), in jc-core's spelling. */
export const APP_REPRESENTATIONS = [
  "ngsi-ld",
  "geojson",
  "csv",
  "xlsx",
  "json",
  "zip",
  "ogc-features",
  "sta",
  "mcp",
] as const;

/** A CSP source jc-core admits: `self`, `none`, or an https origin with no wildcard (AP-12). */
export const CSP_SOURCE_PATTERN = "^(self|none|https://[^*\\s]+)$";

/** An ISO 8601 duration reaching back from now, such as `P1D` or `PT6H` (AP-05). */
export const ISO_DURATION_PATTERN = "^P(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(\\d+H)?(\\d+M)?(\\d+S)?)?$";

/**
 * The `App` a person edits: how it is built and served, who reaches it, where its source is, the
 * toolchain CI pins, what it reads and writes, and its CSP and limits (AP-01…AP-20).
 *
 * `lifecycle` is not a field: publishing is the catalogue's own action, with the confirmation
 * that says what it does (AP-20), and an edit keeps the lifecycle the manifest has. `source` is
 * one choice and its members, because jc-core refuses a source naming both a path and a
 * repository; `build` is a list of pins here and a map in the manifest (AP-11).
 */
export function appSchema(
  t: (key: string) => string,
  spaces: string[] = [],
  granted: string[] = [],
): JsonSchema {
  return {
    type: "object",
    required: ["name", "kind", "visibility", "source", "build", "dataNeeds"],
    properties: {
      name: {
        type: "string",
        title: t("apps.field.name"),
        pattern: DNS1123,
        maxLength: 63,
      },
      kind: {
        type: "string",
        title: t("apps.field.kind"),
        enum: [...APP_CLASSES],
        default: "static",
      },
      visibility: {
        type: "string",
        title: t("apps.field.visibility"),
        enum: [...APP_VISIBILITIES],
        default: "project",
      },
      embeddable: {
        type: "boolean",
        title: t("apps.field.embeddable"),
        default: false,
      },
      source: {
        type: "object",
        title: t("apps.field.source"),
        required: ["from"],
        // The members the choice needs, refused at the field when one is missing (AP-02).
        if: { properties: { from: { const: "git" } } },
        then: { required: ["url", "ref"] },
        else: { required: ["path"] },
        properties: {
          from: {
            type: "string",
            title: t("apps.field.sourceFrom"),
            enum: [...APP_SOURCES],
            default: "path",
          },
          path: {
            type: "string",
            title: t("apps.field.sourcePath"),
            pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$",
          },
          url: {
            type: "string",
            title: t("apps.field.gitUrl"),
            pattern: "^https://\\S+$",
          },
          ref: { type: "string", title: t("apps.field.gitRef"), pattern: "^\\S+$" },
          subdirectory: {
            type: "string",
            title: t("apps.field.gitPath"),
            pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$",
          },
        },
      },
      build: {
        type: "array",
        title: t("apps.field.build"),
        minItems: 1,
        items: {
          type: "object",
          required: ["tool", "version"],
          properties: {
            tool: {
              type: "string",
              title: t("apps.field.buildTool"),
              pattern: "^[a-z][a-z0-9_-]*$",
            },
            version: {
              type: "string",
              title: t("apps.field.buildVersion"),
              pattern: "^\\S+$",
            },
          },
        },
      },
      dataNeeds: {
        type: "array",
        title: t("apps.field.dataNeeds"),
        minItems: 1,
        items: {
          type: "object",
          required: ["contextSpaceRef", "types", "operations"],
          properties: {
            contextSpaceRef: {
              type: "string",
              title: t("apps.field.space"),
              ...(spaces.length > 0 ? { enum: spaces } : { pattern: DNS1123 }),
            },
            types: {
              type: "array",
              title: t("apps.field.types"),
              minItems: 1,
              items: { type: "string", pattern: ENTITY_TYPE_PATTERN },
              uniqueItems: true,
            },
            attrs: {
              type: "array",
              title: t("apps.field.attrs"),
              items: { type: "string", pattern: "^\\S+$" },
              uniqueItems: true,
            },
            operations: {
              type: "array",
              title: t("apps.field.operations"),
              minItems: 1,
              items: {
                type: "string",
                enum: [...new Set([...OPERATION_CHOICES, ...granted])],
              },
              uniqueItems: true,
            },
            representations: {
              type: "array",
              title: t("apps.field.representations"),
              items: { type: "string", enum: [...APP_REPRESENTATIONS] },
              uniqueItems: true,
            },
            q: { type: "string", title: "q" },
            scopeQ: { type: "string", title: "scopeQ" },
            within: {
              type: "string",
              title: t("apps.field.within"),
              pattern: "^/\\S+$",
            },
            window: {
              type: "string",
              title: t("apps.field.window"),
              pattern: ISO_DURATION_PATTERN,
            },
          },
        },
      },
      csp: {
        type: "object",
        title: t("apps.field.csp"),
        properties: {
          connectSrc: {
            type: "array",
            title: t("apps.field.connectSrc"),
            items: { type: "string", pattern: CSP_SOURCE_PATTERN },
            uniqueItems: true,
          },
          frameAncestors: {
            type: "array",
            title: t("apps.field.frameAncestors"),
            items: { type: "string", pattern: CSP_SOURCE_PATTERN },
            uniqueItems: true,
          },
        },
      },
      limits: {
        type: "object",
        title: t("apps.field.limits"),
        properties: {
          requestsPerMinute: {
            type: "integer",
            title: t("apps.field.requestsPerMinute"),
            minimum: 1,
          },
          maxFileRows: {
            type: "integer",
            title: t("apps.field.maxFileRows"),
            minimum: 1,
          },
        },
      },
    },
  };
}

/** The operations picker for each data need, as the Policy form has it (T-2282). */
export const appUiSchema: UiSchema = {
  dataNeeds: {
    items: {
      operations: { "ui:widget": "operations" },
      q: { "ui:autocomplete": "off" },
      scopeQ: { "ui:autocomplete": "off" },
    },
  },
};
