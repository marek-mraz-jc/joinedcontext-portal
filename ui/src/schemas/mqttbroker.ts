import type { JsonSchema } from "../components/forms/types";
import { storedMetadata } from "../api/manifest";
import { DNS1123 } from "./kinds";

/**
 * The MqttBroker form (T-3839, MF-54, ADR-N-048): the roles that name which ServiceAccounts may
 * publish or subscribe to which topics, the broker's limits and an optional dedicated port.
 *
 * The bounds are jc-core's (`kinds/mqtt_broker.rs`), so a manifest the API would refuse is caught at
 * the field; the API still decides. A broker holds no credential of its own: a device signs in with
 * its ServiceAccount's token and a pipeline reads on the internal listener.
 */

/** The dedicated ports a broker may ask for (`DEDICATED_PORTS`). */
export const DEDICATED_PORTS = { min: 18830, max: 18849 } as const;

/** A device subscribes under its own client id only, with no wildcard before it. */
export const DEVICE_SUBSCRIBE = "^[^+#]*\\$\\{clientid\\}";

export interface MqttRoleForm {
  name?: string;
  serviceAccounts?: string[];
  publish?: string[];
  subscribe?: string[];
}

export interface MqttBrokerForm {
  name?: string;
  roles?: MqttRoleForm[];
  limits?: { maxMessageBytes?: number; messagesPerSecond?: number; maxConnections?: number };
  port?: number;
}

export function mqttBrokerSchema(t: (key: string) => string): JsonSchema {
  const title = (key: string) => t(`mqttbrokers.field.${key}`);
  const filters = (key: string, pattern?: string): JsonSchema => ({
    type: "array",
    title: title(key),
    items: { type: "string", minLength: 1, maxLength: 256, ...(pattern ? { pattern } : {}) },
  });
  const limit = (key: string, max: number): JsonSchema => ({
    type: "integer",
    title: title(key),
    minimum: 1,
    maximum: max,
  });
  return {
    type: "object",
    required: ["name", "roles"],
    properties: {
      name: { type: "string", title: title("name"), pattern: DNS1123, maxLength: 63 },
      roles: {
        type: "array",
        title: title("roles"),
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "serviceAccounts"],
          properties: {
            name: { type: "string", title: title("roleName"), pattern: DNS1123, maxLength: 63 },
            serviceAccounts: {
              type: "array",
              title: title("serviceAccounts"),
              minItems: 1,
              items: { type: "string", pattern: DNS1123, maxLength: 63 },
            },
            publish: filters("publish"),
            subscribe: filters("subscribe", DEVICE_SUBSCRIBE),
          },
        },
      },
      limits: {
        type: "object",
        title: title("limits"),
        properties: {
          maxMessageBytes: limit("maxMessageBytes", 1024 * 1024),
          messagesPerSecond: limit("messagesPerSecond", 1000),
          maxConnections: limit("maxConnections", 10_000),
        },
      },
      port: { type: "integer", title: title("port"), minimum: DEDICATED_PORTS.min, maximum: DEDICATED_PORTS.max },
    },
  };
}

/** The form as the manifest the API stores; the metadata the form has no field for travels on. */
export function toMqttBrokerManifest(project: string, form: MqttBrokerForm, stored?: unknown): unknown {
  const list = (values?: string[]) => (values ?? []).map((value) => value.trim()).filter(Boolean);
  const limits = Object.fromEntries(
    Object.entries(form.limits ?? {}).filter(([, value]) => typeof value === "number"),
  );
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "MqttBroker",
    metadata: { ...storedMetadata(stored), name: form.name, namespace: project },
    spec: {
      roles: (form.roles ?? []).map((role) => {
        const publish = list(role.publish);
        const subscribe = list(role.subscribe);
        return {
          name: role.name ?? "",
          serviceAccounts: list(role.serviceAccounts),
          ...(publish.length > 0 ? { publish } : {}),
          ...(subscribe.length > 0 ? { subscribe } : {}),
        };
      }),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      ...(typeof form.port === "number" ? { port: form.port } : {}),
    },
  };
}

/** The stored manifest back as the form. */
export function fromMqttBrokerManifest(manifest: unknown): MqttBrokerForm {
  const envelope = (manifest ?? {}) as { metadata?: { name?: string }; spec?: Partial<MqttBrokerForm> };
  const spec = envelope.spec ?? {};
  return {
    name: envelope.metadata?.name ?? "",
    roles: (spec.roles ?? []).map((role) => ({
      name: role.name ?? "",
      serviceAccounts: role.serviceAccounts ?? [],
      publish: role.publish ?? [],
      subscribe: role.subscribe ?? [],
    })),
    ...(spec.limits ? { limits: spec.limits } : {}),
    ...(typeof spec.port === "number" ? { port: spec.port } : {}),
  };
}
