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

export type TableMetaResponse = {
  fields: Array<{
    id: string;
    title: string;
    type: string;
  }>;
};
