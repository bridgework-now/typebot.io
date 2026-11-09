import { safeKy } from "@typebot.io/lib/ky";
import type { ListTableRecordsResponse } from "../types";

export const listAllRecords = async (
  recordsUrl: string,
  apiKey: string,
  searchParams: Record<string, string>,
) => {
  const initialUrl = new URL(recordsUrl);
  for (const [name, value] of Object.entries(searchParams)) {
    initialUrl.searchParams.set(name, value);
  }
  let pageUrl = initialUrl;
  const visitedPageUrls = new Set<string>();
  const records: NonNullable<ListTableRecordsResponse["records"]> = [];

  while (true) {
    if (visitedPageUrls.has(pageUrl.href))
      throw new Error("NocoDB returned a repeated pagination URL");
    visitedPageUrls.add(pageUrl.href);

    const response = await safeKy
      .get(pageUrl.href, { headers: { "xc-token": apiKey } })
      .json<ListTableRecordsResponse>();
    records.push(...(response.records ?? []));
    if (!response.next) return records;

    const nextUrl = new URL(response.next, pageUrl);
    if (
      nextUrl.origin !== initialUrl.origin ||
      nextUrl.pathname !== initialUrl.pathname ||
      nextUrl.username ||
      nextUrl.password
    )
      throw new Error("NocoDB returned an unexpected pagination URL");
    pageUrl = nextUrl;
  }
};
