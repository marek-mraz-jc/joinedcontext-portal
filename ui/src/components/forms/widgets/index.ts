import { EntityPicker } from "./EntityPicker";
import { EntitySelectorField, FormDataContext } from "./EntitySelectorField";
import { DataModelPickerWidget, FormProjectContext, TypePickerWidget } from "./ModelWidgets";
import { OperationsPicker } from "./OperationsPicker";
import { ResourcePicker } from "./ResourcePicker";
import { SecretRefWidget } from "./SecretRef";

export {
  DataModelPickerWidget,
  EntityPicker,
  EntitySelectorField,
  FormDataContext,
  FormProjectContext,
  OperationsPicker,
  ResourcePicker,
  SecretRefWidget,
  TypePickerWidget,
};
export const portalWidgets = {
  dataModelPicker: DataModelPickerWidget,
  entityPicker: EntityPicker,
  operations: OperationsPicker,
  resourcePicker: ResourcePicker,
  secretRef: SecretRefWidget,
  typePicker: TypePickerWidget,
};

/** The Portal's own fields, which a uiSchema names with `ui:field`. */
export const portalFields = {
  entitySelector: EntitySelectorField,
};
