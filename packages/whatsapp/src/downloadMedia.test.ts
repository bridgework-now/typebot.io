import type { WhatsAppCredentials } from "@typebot.io/credentials/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dialog360AuthHeaderName, dialog360BaseUrl } from "./constants";
import { downloadMedia } from "./downloadMedia";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  env: {
    WHATSAPP_CLOUD_API_URL: "https://graph.facebook.com",
    WHATSAPP_CLOUD_API_MEDIA_VERSION: undefined as string | undefined,
  },
}));

vi.mock("@typebot.io/env", () => ({ env: mocks.env }));
vi.mock("@typebot.io/lib/ky", () => ({ ky: { get: mocks.get } }));

const credentials = {
  provider: "meta",
  systemUserAccessToken: "test-token",
  phoneNumberId: "phone-number-id",
} satisfies WhatsAppCredentials["data"];

const mediaUrl = "https://lookaside.fbsbx.com/whatsapp_business/file?hash=test";
const mediaBytes = new Uint8Array([0, 127, 128, 255]);

describe("downloadMedia", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.env.WHATSAPP_CLOUD_API_URL = "https://graph.facebook.com";
    mocks.env.WHATSAPP_CLOUD_API_MEDIA_VERSION = undefined;
  });

  it("defaults to v26.0 and preserves authenticated binary download and MIME handling", async () => {
    mockSuccessfulDownload(mediaUrl);

    const result = await downloadMedia({ mediaId: "media-id", credentials });

    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      "https://graph.facebook.com/v26.0/media-id",
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(2, mediaUrl, {
      headers: {
        Authorization: "Bearer test-token",
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    expect(result).toEqual({
      file: Buffer.from(mediaBytes),
      mimeType: "audio/ogg; codecs=opus",
    });
  });

  it("preserves a custom base URL and accepts an explicit media version", async () => {
    mocks.env.WHATSAPP_CLOUD_API_URL = "https://proxy.example.test/graph";
    mocks.env.WHATSAPP_CLOUD_API_MEDIA_VERSION = "v25.0";
    mockSuccessfulDownload(mediaUrl);

    await downloadMedia({ mediaId: "media-id", credentials });

    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      "https://proxy.example.test/graph/v25.0/media-id",
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(mocks.get.mock.calls[1]?.[0]).toBe(mediaUrl);
  });

  it("keeps credentials without a provider on the Meta path", async () => {
    mockSuccessfulDownload(mediaUrl);

    await downloadMedia({
      mediaId: "media-id",
      credentials: {
        systemUserAccessToken: "test-token",
        phoneNumberId: "phone-number-id",
      },
    });

    expect(mocks.get.mock.calls[0]?.[0]).toBe(
      "https://graph.facebook.com/v26.0/media-id",
    );
  });

  it("preserves the 360dialog host rewrite, query string, and API key headers", async () => {
    mocks.env.WHATSAPP_CLOUD_API_URL = "https://proxy.example.test";
    mocks.env.WHATSAPP_CLOUD_API_MEDIA_VERSION = "v25.0";
    mockSuccessfulDownload("https://other.example.test/media/file?hash=test");

    const result = await downloadMedia({
      mediaId: "media-id",
      credentials: { provider: "360dialog", apiKey: "test-api-key" },
    });

    const headers = { [dialog360AuthHeaderName]: "test-api-key" };
    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      `${dialog360BaseUrl}/media-id`,
      { headers },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      `${dialog360BaseUrl}/media/file?hash=test`,
      { headers },
    );
    expect(result).toEqual({
      file: Buffer.from(mediaBytes),
      mimeType: "audio/ogg; codecs=opus",
    });
  });

  it("propagates metadata errors without attempting the binary download", async () => {
    const error = new Error("Metadata request failed");
    mocks.get.mockReturnValueOnce({
      json: vi.fn().mockRejectedValue(error),
    });

    await expect(
      downloadMedia({ mediaId: "media-id", credentials }),
    ).rejects.toBe(error);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("propagates binary download errors", async () => {
    const error = new Error("Binary request failed");
    mocks.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ url: mediaUrl, mime_type: "audio/ogg" }),
    });
    mocks.get.mockReturnValueOnce({
      arrayBuffer: vi.fn().mockRejectedValue(error),
    });

    await expect(
      downloadMedia({ mediaId: "media-id", credentials }),
    ).rejects.toBe(error);
  });
});

const mockSuccessfulDownload = (url: string) => {
  mocks.get.mockReturnValueOnce({
    json: vi.fn().mockResolvedValue({
      url,
      mime_type: "audio/ogg; codecs=opus",
      id: "media-id",
      file_size: mediaBytes.byteLength,
      sha256: "test-hash",
    }),
  });
  mocks.get.mockReturnValueOnce({
    arrayBuffer: vi.fn().mockResolvedValue(mediaBytes.buffer),
  });
};
