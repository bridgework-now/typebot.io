import { proChatTiers, starterChatTiers } from "@typebot.io/billing/constants";
import Stripe from "stripe";
import { assertProductionEnvironment, confirmAction, runScript } from "./cli";

const chatsProductId = "prod_MVXtq5sATQzIcM";

const createChatsPrices = async () => {
  assertProductionEnvironment();

  if (
    !(await confirmAction({
      message: `Create two production Stripe prices for ${chatsProductId}?`,
    }))
  )
    return;

  const proStripeChatTiers = proChatTiers.map((tier) =>
    "unit_amount_decimal" in tier
      ? {
          ...tier,
          unit_amount_decimal: Stripe.Decimal.from(tier.unit_amount_decimal),
        }
      : tier,
  );

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    // @ts-ignore stripe-version-2024-09-30.acacia
    apiVersion: "2024-09-30.acacia",
  });

  await stripe.prices.create({
    currency: "usd",
    billing_scheme: "tiered",
    recurring: {
      interval: "month",
      usage_type: "metered",
      // @ts-ignore stripe-version-2024-09-30.acacia
      aggregate_usage: "last_during_period",
    },
    tiers: starterChatTiers,
    tiers_mode: "volume",
    tax_behavior: "exclusive",
    product: chatsProductId,
    currency_options: {
      eur: {
        tax_behavior: "exclusive",
        tiers: starterChatTiers,
      },
    },
  });

  await stripe.prices.create({
    currency: "usd",
    billing_scheme: "tiered",
    recurring: {
      interval: "month",
      usage_type: "metered",
      // @ts-ignore stripe-version-2024-09-30.acacia
      aggregate_usage: "last_during_period",
    },
    tiers: proStripeChatTiers,
    tiers_mode: "volume",
    tax_behavior: "exclusive",
    product: chatsProductId,
    currency_options: {
      eur: {
        tax_behavior: "exclusive",
        tiers: proStripeChatTiers,
      },
    },
  });
};

runScript(createChatsPrices);
