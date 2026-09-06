export interface OfapiActionField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "money-list" | "boolean" | "select" | "datetime" | "strings" | "numbers" | "rows";
  required?: boolean;
  help?: string;
  defaultValue?: string | number | boolean;
  options?: { value: string | number | boolean; label: string }[];
  fields?: OfapiActionField[];
}
export interface OfapiActionFormDefinition {
  action: string;
  label: string;
  section: string;
  description: string;
  fields: OfapiActionField[];
}
