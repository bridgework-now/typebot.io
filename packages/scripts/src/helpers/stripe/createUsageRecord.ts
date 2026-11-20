import type Stripe from "stripe";

// Stripe's SDK-upgrade bridge keeps legacy metered prices on Acacia.
export const createUsageRecord = (
  stripe: Stripe,
  subscriptionItemId: string,
  params: {
    quantity: number;
    timestamp: number | "now";
    action?: "increment" | "set";
  },
  options: Stripe.RequestOptions = {},
) =>
  stripe.rawRequest(
    "POST",
    `/v1/subscription_items/${encodeURIComponent(subscriptionItemId)}/usage_records`,
    { action: "increment", ...params },
    { apiVersion: "2024-09-30.acacia", ...options },
  );
