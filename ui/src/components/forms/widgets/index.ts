import { EntityPicker } from "./EntityPicker";
import { EntitySelectorField, FormDataContext } from "./EntitySelectorField";
import { OperationsPicker } from "./OperationsPicker";
import { ResourcePicker } from "./ResourcePicker";
import { SecretRefWidget } from "./SecretRef";

export { EntityPicker, EntitySelectorField, FormDataContext, OperationsPicker, ResourcePicker, SecretRefWidget };
export const portalWidgets = {
  entityPicker: EntityPicker,
  operations: OperationsPicker,
  resourcePicker: ResourcePicker,
  secretRef: SecretRefWidget,
};

/** The Portal's own fields, which a uiSchema names with `ui:field`. */
export const portalFields = {
  entitySelector: EntitySelectorField,
};
