/**
 * The five named operation groups of ETSI GS CIM 009 Table 4.20-2 (R8, GW34).
 *
 * A `Policy` grants operations by their CIM 009 names, and the standard already names the five
 * groups a grant is normally written in, so a person picks `retrieveOps` rather than ticking
 * forty operations. What the Portal has to be able to say is what a group **means**: a group is
 * exactly the operations the table lists for it — never a shorthand the platform widened — so a
 * page that shows the name without the members shows a word nobody can check.
 *
 * The lists here are the table's, and `operation_groups.test.ts` holds them against the same
 * table the gateway is held to (`jc-core`'s `each_operation_group_expands_to_exactly_its_table_members_gw34`).
 * The platform is the enforcer; this is for reading, and a disagreement between the two is a bug
 * in whichever one moved.
 */

export const OPERATION_GROUP_NAMES = [
  "retrieveOps",
  "updateOps",
  "associationOps",
  "federationOps",
  "redirectionOps",
] as const;

export type OperationGroupName = (typeof OPERATION_GROUP_NAMES)[number];

/** The consumption operations `associationOps` and `federationOps` share. */
const CONSUMPTION = [
  "retrieveEntity",
  "queryEntity",
  "queryBatch",
  "retrieveEntityTypes",
  "retrieveEntityTypeDetails",
  "retrieveEntityTypeInfo",
  "retrieveAttrTypes",
  "retrieveAttrTypeDetails",
  "retrieveAttrTypeInfo",
  "createSubscription",
  "updateSubscription",
  "retrieveSubscription",
  "querySubscription",
  "deleteSubscription",
] as const;

/** The EntityMap operations `federationOps` adds to them. */
const ENTITY_MAP = [
  "retrieveEntityMap",
  "updateEntityMap",
  "deleteEntityMap",
  "createEntityMapQueryEntity",
] as const;

export interface OperationGroup {
  name: OperationGroupName;
  /** The operations the group stands for, Table 4.20-2 verbatim. */
  operations: readonly string[];
  /** Whether any operation it stands for changes context data (AP-09). */
  writes: boolean;
}

export const OPERATION_GROUPS: Record<OperationGroupName, OperationGroup> = {
  retrieveOps: {
    name: "retrieveOps",
    operations: ["retrieveEntity", "queryEntity"],
    writes: false,
  },
  updateOps: {
    name: "updateOps",
    operations: ["updateEntity", "updateAttrs", "replaceEntity", "replaceAttrs"],
    writes: true,
  },
  associationOps: {
    name: "associationOps",
    operations: CONSUMPTION,
    writes: false,
  },
  federationOps: {
    name: "federationOps",
    operations: [...CONSUMPTION, ...ENTITY_MAP],
    writes: false,
  },
  redirectionOps: {
    name: "redirectionOps",
    operations: [
      "createEntity",
      "updateEntity",
      "appendAttrs",
      "updateAttrs",
      "deleteAttrs",
      "deleteEntity",
      "mergeEntity",
      "replaceEntity",
      "replaceAttrs",
      "retrieveEntity",
      "queryEntity",
      "purgeEntity",
      "retrieveEntityTypes",
      "retrieveEntityTypeDetails",
      "retrieveEntityTypeInfo",
      "retrieveAttrTypes",
      "retrieveAttrTypeDetails",
      "retrieveAttrTypeInfo",
      "retrieveEntityMap",
      "updateEntityMap",
      "deleteEntityMap",
      "createEntityMapQueryEntity",
    ],
    writes: true,
  },
};

/** The group a name stands for, or nothing when the name is a single operation. */
export function groupOf(name: string): OperationGroup | undefined {
  return (OPERATION_GROUPS as Record<string, OperationGroup | undefined>)[name];
}

/**
 * The operations a grant's `operations` list really covers, groups expanded, each once.
 *
 * A name that is neither a Table 4.20-1 operation nor a group is kept as it stands rather than
 * dropped: the manifest is refused by the API before it is ever stored (GW34), and silently
 * hiding it here would make a refused policy look like a narrower one.
 */
export function expandOperations(operations: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const name of operations) {
    const group = groupOf(name);
    if (group) {
      for (const operation of group.operations) {
        expanded.add(operation);
      }
    } else {
      expanded.add(name);
    }
  }
  return [...expanded];
}

/** Whether a grant can change context data: any write operation, or a group that holds one. */
export function grantWrites(operations: readonly string[]): boolean {
  return operations.some((name) => {
    const group = groupOf(name);
    return group ? group.writes : WRITE_OPERATIONS.has(name);
  });
}

/**
 * The Table 4.20-1 operations that change context or subscription state, for a grant that names
 * operations one by one instead of by group (GW15, GW16; `Operation::is_write` in `jc-core`,
 * which this list is held against).
 *
 * A subscription write is in here and is deliberately *not* what makes `associationOps` or
 * `federationOps` a write: `OperationGroup::includes_write` counts only the groups that change
 * context data, and the Portal says what the platform decides, not what it would decide itself.
 */
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "createEntity",
  "updateEntity",
  "appendAttrs",
  "updateAttrs",
  "deleteAttrs",
  "deleteEntity",
  "createBatch",
  "upsertBatch",
  "updateBatch",
  "deleteBatch",
  "upsertTemporal",
  "appendAttrsTemporal",
  "deleteAttrsTemporal",
  "updateAttrInstanceTemporal",
  "deleteAttrInstanceTemporal",
  "deleteTemporal",
  "mergeEntity",
  "replaceEntity",
  "replaceAttrs",
  "mergeBatch",
  "purgeEntity",
  "createSubscription",
  "updateSubscription",
  "deleteSubscription",
]);
