"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Coins } from "lucide-react";

type BillingSummaryPayload = {
  state?: {
    subscription?: {
      plan?: string;
    };
    wallet?: {
      monthlyTokensRemaining?: number;
      purchasedTokensRemaining?: number;
    };
    availableTokens?: number;
  };
};

type TokenStatusEventDetail = {
  message?: string;
  availableTokens?: number;
  refresh?: boolean;
};

const TOKEN_STATUS_EVENT = "billing:token-status";

function formatTokens(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return Math.max(0, Math.round(value)).toLocaleString();
}

export function TokenStatusChip() {
  const [plan, setPlan] = useState<string>("Free");
  const [monthlyTokens, setMonthlyTokens] = useState<number>(0);
  const [purchasedTokens, setPurchasedTokens] = useState<number>(0);
  const [availableTokens, setAvailableTokens] = useState<number>(0);
  const [actionNote, setActionNote] = useState<string>("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/billing/summary", {
      method: "GET",
      cache: "no-store"
    });
    if (!response.ok) return;
    const payload = (await response.json()) as BillingSummaryPayload;
    const nextPlan = payload.state?.subscription?.plan;
    const nextMonthly = Number(payload.state?.wallet?.monthlyTokensRemaining ?? 0);
    const nextPurchased = Number(payload.state?.wallet?.purchasedTokensRemaining ?? 0);
    const nextAvailable = Number(payload.state?.availableTokens ?? nextMonthly + nextPurchased);
    setPlan(typeof nextPlan === "string" && nextPlan.trim().length > 0 ? nextPlan : "Free");
    setMonthlyTokens(Math.max(0, Math.round(nextMonthly)));
    setPurchasedTokens(Math.max(0, Math.round(nextPurchased)));
    setAvailableTokens(Math.max(0, Math.round(nextAvailable)));
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 20000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<TokenStatusEventDetail>).detail;
      if (!detail || typeof detail !== "object") return;
      if (typeof detail.availableTokens === "number" && Number.isFinite(detail.availableTokens)) {
        setAvailableTokens(Math.max(0, Math.round(detail.availableTokens)));
      }
      if (typeof detail.message === "string") {
        setActionNote(detail.message);
      }
      if (detail.refresh) {
        void refresh();
      }
    };
    window.addEventListener(TOKEN_STATUS_EVENT, handler);
    return () => {
      window.removeEventListener(TOKEN_STATUS_EVENT, handler);
    };
  }, [refresh]);

  useEffect(() => {
    if (!actionNote) return;
    const timeout = window.setTimeout(() => setActionNote(""), 5000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [actionNote]);

  const walletLabel = useMemo(() => {
    return `M ${formatTokens(monthlyTokens)} • P ${formatTokens(purchasedTokens)}`;
  }, [monthlyTokens, purchasedTokens]);

  return (
    <div className="hidden items-center gap-2 rounded-xl border border-border/70 bg-background/75 px-3 py-1.5 text-xs text-zinc-200 lg:flex">
      <Coins className="h-3.5 w-3.5 text-emerald-300" />
      <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
        {plan}
      </span>
      <span className="font-medium text-white">{formatTokens(availableTokens)} tokens</span>
      <span className="text-zinc-400">{walletLabel}</span>
      {actionNote ? <span className="max-w-[240px] truncate text-zinc-300">{actionNote}</span> : null}
    </div>
  );
}
