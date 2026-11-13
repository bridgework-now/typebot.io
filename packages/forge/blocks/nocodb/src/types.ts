export type NocoDbRecord = {
  id: string | number;
  fields?: Record<string, any>;
};

export type ListTableRecordsResponse = {
  records: NocoDbRecord[];
  next?: string | null;
};

// Non exhaustive list of types
type UiDataType =
  | "SingleLineText"
  | "ID"
  | "Email"
  | "LinkToAnotherRecord"
  | "Links";

export type TableMetaResponse = {
  base_id: string;
  fields: Array<{
    id: string;
    title: string;
    type: UiDataType;
  }>;
};
