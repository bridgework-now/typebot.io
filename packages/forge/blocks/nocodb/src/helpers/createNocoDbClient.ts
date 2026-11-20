import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl, defaultLimitForSearch } from "../constants";
import type { ListTableRecordsResponse, TableMetaResponse } from "../types";

type Params = {
  baseUrl: string | undefined;
  baseId?: string;
  apiKey: string;
  tableId: string;
};

type DataRecord = {
  id: string | number;
  id_fields?: Record<string, unknown>;
  fields?: Record<string, unknown>;
};

type TableSchema = {
  fields: { id: string; title: string; type: string }[];
};

export const createNocoDbClient = ({
  baseUrl,
  baseId,
  apiKey,
  tableId,
}: Params) => {
  if (!tableId) throw new Error("Table ID is required");

  const origin = baseUrl ?? defaultBaseUrl;
  // Saved credentials predate baseId. Keep their documented v2 behavior
  // until the connection is explicitly configured for v3.
  if (!baseId) {
    const dataUrl = `${origin}/api/v2/tables/${encodeURIComponent(tableId)}`;
    const headers = { "xc-token": apiKey };
    return {
      getTableMetadata: () =>
        safeKy
          .get(`${origin}/api/v2/meta/tables/${encodeURIComponent(tableId)}`, {
            headers,
          })
          .json<TableMetaResponse>(),
      listRecords: (searchParams: Record<string, string>) =>
        safeKy
          .get(`${dataUrl}/records`, { headers, searchParams })
          .json<ListTableRecordsResponse>(),
      createRecord: (fields: Record<string, unknown>) =>
        safeKy
          .post(`${dataUrl}/records`, { headers, json: fields })
          .json<{ Id: string | number }>(),
      updateRecords: async (records: Record<string, any>[]) => {
        await safeKy.patch(`${dataUrl}/records`, { headers, json: records });
      },
      linkRecords: (fieldId: string, recordId: string | number, ids: string[]) =>
        safeKy
          .post(
            `${dataUrl}/links/${encodeURIComponent(fieldId)}/records/${encodeURIComponent(recordId)}`,
            { headers, json: ids.map((id) => ({ Id: id })) },
          )
          .json(),
    };
  }

  const encodedBaseId = encodeURIComponent(baseId);
  const encodedTableId = encodeURIComponent(tableId);
  const dataUrl = `${origin}/api/v3/data/${encodedBaseId}/${encodedTableId}`;
  const metadataUrl = `${origin}/api/v3/meta/bases/${encodedBaseId}/tables/${encodedTableId}`;
  const headers = { "xc-token": apiKey };
  let tableSchema: Promise<TableSchema> | undefined;

  const getTableSchema = () => {
    tableSchema ??= safeKy.get(metadataUrl, { headers }).json<TableSchema>();
    return tableSchema;
  };

  const getRelationFields = async () =>
    (await getTableSchema()).fields.filter(
      (field) =>
        field.type === "LinkToAnotherRecord" || field.type === "Links",
    );

  // Keep relation writes additive through the dedicated link endpoint.
  // V3 record PATCH would instead replace the entire link set.
  const withoutRelations = async (fields: Record<string, unknown>) => {
    const relationFields = await getRelationFields();
    const relationNames = new Set(
      relationFields.flatMap((field) => [field.id, field.title]),
    );
    return Object.fromEntries(
      Object.entries(fields).filter(([name]) => !relationNames.has(name)),
    );
  };

  return {
    getTableMetadata: async (): Promise<TableMetaResponse> => ({
      columns: (await getTableSchema()).fields.map((field) => ({
        id: field.id,
        title: field.title,
        uidt: field.type,
      })),
    }),

    listRecords: async (
      searchParams: Record<string, string>,
    ): Promise<ListTableRecordsResponse> => {
      const { limit: configuredLimit, ...filters } = searchParams;
      const limit = Number(configuredLimit ?? defaultLimitForSearch);
      const records: DataRecord[] = [];
      const pageSize = Math.min(limit, 100);
      let pageNumber = 1;

      while (records.length < limit) {
        const page = await safeKy
          .get(`${dataUrl}/records`, {
            headers,
            searchParams: {
              ...filters,
              pageSize,
              page: pageNumber,
            },
          })
          .json<{ records: DataRecord[]; next?: string | null }>();
        records.push(...page.records.slice(0, limit - records.length));
        if (!page.next || page.records.length === 0) break;
        // Keep the page size fixed so page boundaries remain consistent.
        // Rebuild pagination against the configured host instead of forwarding
        // credentials to a URL supplied in a response.
        pageNumber += 1;
      }

      const { count } = await safeKy
        .get(`${dataUrl}/count`, { headers, searchParams: filters })
        .json<{ count: number }>();
      const relationNames = new Set(
        (await getRelationFields()).map((field) => field.title),
      );
      const list: ListTableRecordsResponse["list"] = [];

      for (const selectedRecord of records) {
        // V2 view selection returned hidden fields too. V3 view selection
        // omits them, so hydrate the selected IDs without a view restriction.
        const record = filters.viewId
          ? await safeKy
              .get(
                `${dataUrl}/records/${encodeURIComponent(selectedRecord.id)}`,
                { headers },
              )
              .json<DataRecord>()
          : selectedRecord;
        const fields = Object.fromEntries(
          Object.entries(record.fields ?? {}).map(([name, value]) => [
            name,
            relationNames.has(name) ? flattenLinkedValue(value) : value,
          ]),
        );
        list.push({ ...fields, ...record.id_fields, Id: record.id });
      }

      return {
        list,
        pageInfo: {
          totalRows: count,
          page: 1,
          pageSize: limit,
          isFirstPage: true,
          isLastPage: records.length >= count,
        },
      };
    },

    createRecord: async (fields: Record<string, unknown>) => {
      const response = await safeKy
        .post(`${dataUrl}/records`, {
          headers,
          json: { fields: await withoutRelations(fields) },
        })
        .json<{ records: DataRecord[] }>();
      const record = response.records[0];
      if (!record) throw new Error("NocoDB did not return a created record");
      return { Id: record.id };
    },

    updateRecords: async (records: Record<string, any>[]) => {
      for (let offset = 0; offset < records.length; offset += 10) {
        const batch = [];
        for (const { Id, ...fields } of records.slice(offset, offset + 10)) {
          batch.push({ id: Id, fields: await withoutRelations(fields) });
        }
        // The handlers intentionally ignore the update response body.
        await safeKy.patch(`${dataUrl}/records`, { headers, json: batch });
      }
    },

    linkRecords: (fieldId: string, recordId: string | number, ids: string[]) =>
      safeKy
        .post(
          `${dataUrl}/links/${encodeURIComponent(fieldId)}/${encodeURIComponent(recordId)}`,
          { headers, json: ids.map((id) => ({ id })) },
        )
        .json<{ success: boolean }>(),
  };
};

const flattenLinkedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(flattenLinkedValue);
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    "fields" in value &&
    value.fields !== null &&
    typeof value.fields === "object"
  ) {
    const primaryFields =
      "id_fields" in value &&
      value.id_fields !== null &&
      typeof value.id_fields === "object"
        ? value.id_fields
        : {};
    return { ...value.fields, ...primaryFields, Id: value.id };
  }
  return value;
};
