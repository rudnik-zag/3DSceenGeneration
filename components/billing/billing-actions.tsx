"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { PlanDefinition, TokenPackDefinition } from "@/lib/billing/plans";

async function readErrorMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : null;
    if (message) return message;
  }
  return fallback;
}

export function BillingActions(props: {
  plans: PlanDefinition[];
  tokenPacks: TokenPackDefinition[];
  currentPlan: string;
  canOpenPortal: boolean;
}) {
  const router = useRouter();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const redirectFromApiPayload = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return false;
    const record = payload as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : null;
    if (!url) return false;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      window.location.assign(url);
      return true;
    }
    router.push(url);
    router.refresh();
    return true;
  };

  const startSubscriptionCheckout = async (plan: string) => {
    setLoadingKey(`plan:${plan}`);
    try {
      const response = await fetch("/api/billing/checkout/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan })
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to start checkout."));
      }
      const payload = await response.json().catch(() => null);
      if (!redirectFromApiPayload(payload)) {
        throw new Error("Checkout URL missing.");
      }
    } catch (error) {
      toast({
        title: "Checkout failed",
        description: error instanceof Error ? error.message : "Unknown checkout error"
      });
    } finally {
      setLoadingKey(null);
    }
  };

  const startTokenPackCheckout = async (packKey: string) => {
    setLoadingKey(`pack:${packKey}`);
    try {
      const response = await fetch("/api/billing/checkout/token-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packKey })
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to start checkout."));
      }
      const payload = await response.json().catch(() => null);
      if (!redirectFromApiPayload(payload)) {
        throw new Error("Checkout URL missing.");
      }
    } catch (error) {
      toast({
        title: "Checkout failed",
        description: error instanceof Error ? error.message : "Unknown checkout error"
      });
    } finally {
      setLoadingKey(null);
    }
  };

  const openBillingPortal = async () => {
    setLoadingKey("portal");
    try {
      const response = await fetch("/api/billing/portal", {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to open billing portal."));
      }
      const payload = await response.json().catch(() => null);
      if (!redirectFromApiPayload(payload)) {
        throw new Error("Portal URL missing.");
      }
    } catch (error) {
      toast({
        title: "Portal unavailable",
        description: error instanceof Error ? error.message : "Unknown portal error"
      });
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {props.plans.map((plan) => {
          const isCurrent = plan.key === props.currentPlan;
          const loading = loadingKey === `plan:${plan.key}`;
          return (
            <div key={plan.key} className="rounded-xl border border-border/70 bg-black/30 p-4">
              <p className="text-sm font-semibold text-white">{plan.title}</p>
              <p className="mt-1 text-xs text-zinc-400">{plan.description}</p>
              <p className="mt-2 text-lg font-semibold text-white">
                {plan.monthlyPriceUsd === 0 ? "Free" : `$${plan.monthlyPriceUsd}/month`}
              </p>
              <p className="text-xs text-zinc-300">{plan.entitlements.monthlyTokenAllowance.toLocaleString()} tokens/month</p>
              <Button
                className="mt-3 w-full"
                variant={isCurrent ? "secondary" : "default"}
                disabled={loading || isCurrent}
                onClick={() => void startSubscriptionCheckout(plan.key)}
              >
                {isCurrent ? "Current Plan" : loading ? "Opening..." : `Choose ${plan.title}`}
              </Button>
            </div>
          );
        })}
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {props.tokenPacks.map((pack) => {
          const loading = loadingKey === `pack:${pack.key}`;
          return (
            <div key={pack.key} className="rounded-xl border border-border/70 bg-black/30 p-4">
              <p className="text-sm font-semibold text-white">{pack.title}</p>
              <p className="mt-1 text-xs text-zinc-400">{pack.description}</p>
              <p className="mt-2 text-base font-semibold text-white">{pack.tokens.toLocaleString()} tokens</p>
              <p className="text-xs text-zinc-300">${pack.priceUsd} one-time</p>
              <Button className="mt-3 w-full" disabled={loading} onClick={() => void startTokenPackCheckout(pack.key)}>
                {loading ? "Opening..." : "Buy Pack"}
              </Button>
            </div>
          );
        })}
      </section>

      <div>
        <Button variant="outline" disabled={!props.canOpenPortal || loadingKey === "portal"} onClick={() => void openBillingPortal()}>
          {loadingKey === "portal" ? "Opening..." : "Open Billing Portal"}
        </Button>
      </div>
    </div>
  );
}

