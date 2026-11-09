export type ListTableRecordsResponse = {
  records?: Array<{
    id: string | number;
    fields?: Record<string, any>;
  }>;
  next?: string | null;
  prev?: string | null;
};

// Non exhaustive list of types
type UiDataType = "SingleLineText" | "ID" | "Email" | "LinkToAnotherRecord" | "Links";

export type TableMetaResponse = {
  fields: Array<{
    id: string;
    title: string;
    type: UiDataType;
  }>;
};
