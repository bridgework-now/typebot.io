import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSetupMetaWebhook } from "./api/handleSetupMetaWebhook";
import { downloadMedia } from "./downloadMedia";

const mocks = vi.hoisted(() => ({
  env: { WHATSAPP_CLOUD_API_URL: "https://graph.facebook.com" },
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@typebot.io/env", () => ({ env: mocks.env }));
vi.mock("@typebot.io/lib/ky", () => ({
  ky: { get: mocks.get, post: mocks.post },
}));
vi.mock("@typebot.io/lib/createToastORPCError", () => ({
  createToastORPCError: async (error: unknown) => error,
}));

const queueJsonResponses = (...responses: unknown[]) => {
  for (const response of responses)
    mocks.get.mockReturnValueOnce({ json: async () => response });
};

const input = {
  systemToken: "test-token",
  appSecret: "test-secret",
  wabaId: "waba-id",
  phoneNumberId: "phone-id",
  subscribe: true,
};

const phoneNumber = {
  id: "phone-id",
  display_phone_number: "+1 555-0100",
};

const authorizationHeaders = { Authorization: "Bearer test-token" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.WHATSAPP_CLOUD_API_URL = "https://graph.facebook.com";
  mocks.post.mockResolvedValue(undefined);
});

describe("Meta Graph API migration", () => {
  it.each([
    "https://graph.facebook.com",
    "https://proxy.example.test/graph",
  ])("preserves setup behavior with base URL %s", async (baseUrl) => {
    mocks.env.WHATSAPP_CLOUD_API_URL = baseUrl;
    const nextUrl = `${baseUrl}/v26.0/waba-id/phone_numbers?after=cursor`;
    queueJsonResponses(
      { data: { app_id: "app-id" } },
      { data: [], paging: { next: nextUrl } },
      { data: [phoneNumber] },
      { data: [] },
    );

    await expect(handleSetupMetaWebhook({ input })).resolves.toEqual({
      name: "+15550100",
      wabaId: "waba-id",
      subscribedAppId: "app-id",
      wasAlreadySubscribed: false,
    });

    const requestedUrls = mocks.get.mock.calls.map(([url]) => new URL(url));
    expect(requestedUrls.map((url) => url.origin + url.pathname)).toEqual([
      `${baseUrl}/v26.0/debug_token`,
      `${baseUrl}/v26.0/waba-id/phone_numbers`,
      `${baseUrl}/v26.0/waba-id/phone_numbers`,
      `${baseUrl}/v26.0/waba-id/subscribed_apps`,
    ]);
    expect(requestedUrls[0].searchParams.get("input_token")).toBe("test-token");
    expect(requestedUrls[1].searchParams.get("fields")).toBe(
      "id,display_phone_number",
    );
    expect(requestedUrls[1].searchParams.get("limit")).toBe("100");
    expect(requestedUrls[2].searchParams.get("after")).toBe("cursor");

    const appSecretProof = requestedUrls[0].searchParams.get("appsecret_proof");
    expect(appSecretProof).toMatch(/^[a-f0-9]{64}$/);
    for (const url of requestedUrls)
      expect(url.searchParams.get("appsecret_proof")).toBe(appSecretProof);
    for (const [, options] of mocks.get.mock.calls)
      expect(options.headers).toEqual(authorizationHeaders);

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [subscriptionUrl, subscriptionOptions] = mocks.post.mock.calls[0];
    expect(subscriptionUrl.origin + subscriptionUrl.pathname).toBe(
      `${baseUrl}/v26.0/waba-id/subscribed_apps`,
    );
    expect(subscriptionUrl.searchParams.get("appsecret_proof")).toBe(
      appSecretProof,
    );
    expect(subscriptionOptions).toEqual({ headers: authorizationHeaders });
  });

  it.each([
    { id: "app-id" },
    { whatsapp_business_api_data: { id: "app-id" } },
  ])("does not subscribe an already subscribed app: %j", async (app) => {
    queueJsonResponses(
      { data: { app_id: "app-id" } },
      { data: [phoneNumber] },
      { data: [app] },
    );

    await expect(handleSetupMetaWebhook({ input })).resolves.toMatchObject({
      wasAlreadySubscribed: true,
      subscribedAppId: "app-id",
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("skips subscription requests when subscription is disabled", async () => {
    queueJsonResponses(
      { data: { app_id: "app-id" } },
      { data: [phoneNumber] },
    );

    await expect(
      handleSetupMetaWebhook({ input: { ...input, subscribe: false } }),
    ).resolves.toMatchObject({ wasAlreadySubscribed: false });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("preserves the authenticated two-step media download and returned bytes", async () => {
    mocks.env.WHATSAPP_CLOUD_API_URL = "https://proxy.example.test/graph";
    const mediaUrl = "https://media.example.test/file?signature=test";
    queueJsonResponses({ url: mediaUrl, mime_type: "image/png" });
    mocks.get.mockReturnValueOnce({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await expect(
      downloadMedia({
        mediaId: "media-id",
        credentials: {
          provider: "meta",
          systemUserAccessToken: "test-token",
          phoneNumberId: "phone-id",
        },
      }),
    ).resolves.toEqual({
      file: Buffer.from([1, 2, 3]),
      mimeType: "image/png",
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      "https://proxy.example.test/graph/v26.0/media-id",
      { headers: authorizationHeaders },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(2, mediaUrl, {
      headers: {
        ...authorizationHeaders,
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
  });
});
