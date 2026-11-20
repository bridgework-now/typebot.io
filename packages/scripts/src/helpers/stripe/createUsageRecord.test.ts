import { describe, expect, it } from "bun:test";
import Stripe from "stripe";
import { createUsageRecord } from "./createUsageRecord";

describe("legacy usage reporting with the current Stripe SDK", () => {
  it("keeps the Acacia wire format, idempotency key, and parsed response", async () => {
    const usageRecord = {
      id: "mbur_test",
      object: "usage_record",
      quantity: 7,
      subscription_item: "si_test",
      timestamp: 1730000000,
    };
    const { stripe, requests } = createClient(usageRecord);

    const result = await createUsageRecord(
      stripe,
      "si_test",
      { quantity: 7, timestamp: "now" },
      { idempotencyKey: "usage-test" },
    );

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      "/v1/subscription_items/si_test/usage_records",
    );
    expect(request.headers.get("stripe-version")).toBe("2024-09-30.acacia");
    expect(request.headers.get("idempotency-key")).toBe("usage-test");
    const params = new URLSearchParams(await request.text());
    expect(Object.fromEntries(params)).toEqual({
      quantity: "7",
      timestamp: "now",
      action: "increment",
    });
    expect(result).toMatchObject(usageRecord);
    expect(result.lastResponse.requestId).toBe("req_test");
  });

  it("preserves explicit action, timestamp, version, and account overrides", async () => {
    const { stripe, requests } = createClient({ id: "mbur_test" });

    await createUsageRecord(
      stripe,
      "si_test",
      { quantity: 0, timestamp: 1730000000, action: "set" },
      {
        apiVersion: "2025-02-24.acacia",
        stripeAccount: "acct_test",
        idempotencyKey: "usage-override",
      },
    );

    const request = requests[0];
    expect(request.headers.get("stripe-version")).toBe("2025-02-24.acacia");
    expect(request.headers.get("stripe-account")).toBe("acct_test");
    expect(request.headers.get("idempotency-key")).toBe("usage-override");
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      quantity: "0",
      timestamp: "1730000000",
      action: "set",
    });
  });

  it("continues to reject with Stripe errors", async () => {
    const { stripe, requests } = createClient(
      {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such subscription item",
        },
      },
      404,
    );

    await expect(
      createUsageRecord(stripe, "si_missing", { quantity: 1, timestamp: "now" }),
    ).rejects.toMatchObject({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    });
    expect(requests).toHaveLength(1);
  });
});

const createClient = (responseBody: object, status = 200) => {
  const requests: Request[] = [];
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(responseBody, {
        status,
        headers: { "request-id": "req_test" },
      });
    },
    { preconnect: () => {} },
  );
  const stripe = new Stripe("sk_test_placeholder", {
    httpClient: Stripe.createFetchHttpClient(fetchMock),
    maxNetworkRetries: 0,
    telemetry: false,
  });
  return { stripe, requests };
};
