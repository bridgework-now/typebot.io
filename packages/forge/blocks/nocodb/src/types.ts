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
type UiDataType = "SingleLineText" | "ID" | "Email" | "LinkToAnotherRecord";

export type TableMetaResponse = {
  columns: Array<{
    id: string;
    title: string;
    uidt: UiDataType;
  }>;
};
