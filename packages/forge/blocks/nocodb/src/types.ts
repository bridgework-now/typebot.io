export type RecordV3 = {
  id: string | number;
  id_fields?: Record<string, any>;
  fields: Record<string, any>;
};

export type ListTableRecordsResponse = {
  list: Array<{
    Id: string | number;
    [key: string]: any;
  }>;
  pageInfo: {
    totalRows: number;
    page: number;
    pageSize: number;
    isFirstPage: boolean;
    isLastPage: boolean;
  };
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
