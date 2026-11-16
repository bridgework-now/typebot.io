import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { ListTableRecordsResponse } from "../types";
import { parseSearchParams } from "./parseSearchParams";

export const createNocoDbClient = ({
  baseUrl,
  baseId,
  apiKey,
  tableId,
}: {
  baseUrl: string | undefined;
  baseId: string;
  apiKey: string;
  tableId: string;
}) => {
  const host = baseUrl ?? defaultBaseUrl;
  const basePath = encodeURIComponent(baseId);
  const tablePath = encodeURIComponent(tableId);
  const dataUrl = `${host}/api/v3/data/${basePath}/${tablePath}`;
  const headers = { "xc-token": apiKey };
  let tablePromise: Promise<TableMetadata> | undefined;

  const getTable = () => {
    tablePromise ??= safeKy
      .get(`${host}/api/v3/meta/bases/${basePath}/tables/${tablePath}`, {
        headers,
      })
      .json<{ fields: { id: string; title: string; type: string }[] }>()
      .then(({ fields }) => ({
        columns: fields.map((field) => ({
          id: field.id,
          title: field.title,
          uidt: field.type === "Links" ? "LinkToAnotherRecord" : field.type,
        })),
      }));
    return tablePromise;
  };

  const excludeLinkFields = async (fields: Record<string, any>) => {
    const table = await getTable();
    const linkFields = new Set(
      table.columns
        .filter((column) => column.uidt === "LinkToAnotherRecord")
        .flatMap((column) => [column.id, column.title]),
    );
    return Object.fromEntries(
      Object.entries(fields).filter(([field]) => !linkFields.has(field)),
    );
  };

  return {
    getTable,
    createRecord: async (fields: Record<string, any>) => {
      const response = await safeKy
        .post(`${dataUrl}/records`, {
          headers,
          json: { fields: await excludeLinkFields(fields) },
        })
        .json<{ records: DataRecord[] }>();
      const record = response.records[0];
      if (!record) throw new Error("NocoDB did not return the created record");
      return { Id: record.id };
    },
    listRecords: async ({
      where,
      viewId,
      limit,
    }: {
      where: string | undefined;
      viewId: string | undefined;
      limit: number;
    }): Promise<ListTableRecordsResponse> => {
      const filters = parseSearchParams({ where, viewId });
      const { count } = await safeKy
        .get(`${dataUrl}/count`, { headers, searchParams: filters })
        .json<{ count: number }>();
      const list: ListTableRecordsResponse["list"] = [];
      let page = 1;
      let hasNext = false;
      do {
        const response = await safeKy
          .get(`${dataUrl}/records`, {
            headers,
            searchParams: {
              ...filters,
              page: String(page),
              pageSize: String(Math.min(limit, 100)),
              linksAsLtar: "true",
            },
          })
          .json<{ records: DataRecord[]; next?: string | null }>();
        list.push(
          ...response.records.slice(0, limit - list.length).map((record) => ({
            ...record.fields,
            ...record.id_fields,
            Id: record.id,
          })),
        );
        hasNext = Boolean(response.next) && response.records.length > 0;
        page++;
      } while (hasNext && list.length < limit);
      return {
        list,
        pageInfo: {
          totalRows: count,
          page: 1,
          pageSize: list.length,
          isFirstPage: true,
          isLastPage: !hasNext,
        },
      };
    },
    updateRecords: async (records: Record<string, any>[]) => {
      for (const { Id, ...fields } of records) {
        const writableFields = await excludeLinkFields(fields);
        if (Object.keys(writableFields).length === 0) continue;
        // Single-record writes also work on deployments with lower batch caps.
        await safeKy.patch(`${dataUrl}/records`, {
          headers,
          json: { id: Id, fields: writableFields },
        });
      }
    },
    linkRecords: async (
      relationId: string,
      recordId: string | number,
      recordIds: string[],
    ) =>
      safeKy
        .post(
          `${dataUrl}/links/${encodeURIComponent(relationId)}/${encodeURIComponent(recordId)}`,
          {
            headers,
            json: recordIds.map((id) => ({ id })),
          },
        )
        .json(),
  };
};

 type TableMetadata = {
  columns: { id: string; title: string; uidt: string }[];
};

 type DataRecord = {
  id: string | number;
  id_fields?: Record<string, any>;
  fields?: Record<string, any>;
};
