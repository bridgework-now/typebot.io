import type { WhatsAppCredentials } from "@typebot.io/credentials/schemas";
import { env } from "@typebot.io/env";
import { ky } from "@typebot.io/lib/ky";
import { dialog360AuthHeaderName, dialog360BaseUrl } from "./constants";

type Props = {
  mediaId: string;
  credentials: WhatsAppCredentials["data"];
};

export const downloadMedia = async ({
  mediaId,
  credentials,
}: Props): Promise<{ file: Buffer; mimeType: string }> => {
  if (credentials.provider === "360dialog") {
    const { url, mime_type } = await ky
      .get(`${dialog360BaseUrl}/${mediaId}`, {
        headers: {
          [dialog360AuthHeaderName]: credentials.apiKey,
        },
      })
      .json<{ url: string; mime_type: string }>();
    const mediaPathNameWithQueryParams =
      new URL(url).pathname + new URL(url).search;

    return {
      file: Buffer.from(
        await ky
          .get(`${dialog360BaseUrl}${mediaPathNameWithQueryParams}`, {
            headers: {
              [dialog360AuthHeaderName]: credentials.apiKey,
            },
          })
          .arrayBuffer(),
      ),
      mimeType: mime_type,
    };
  }
  const mediaApiVersion = env.WHATSAPP_CLOUD_API_MEDIA_VERSION ?? "v26.0";
  const { url, mime_type } = await ky
    .get(`${env.WHATSAPP_CLOUD_API_URL}/${mediaApiVersion}/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${credentials.systemUserAccessToken}`,
      },
    })
    .json<{ url: string; mime_type: string }>();

  return {
    file: Buffer.from(
      await ky
        .get(url, {
          headers: {
            Authorization: `Bearer ${credentials.systemUserAccessToken}`,
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          },
        })
        .arrayBuffer(),
    ),
    mimeType: mime_type,
  };
};
