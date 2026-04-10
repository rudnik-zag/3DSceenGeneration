import Link from "next/link";

import { BillingActions } from "@/components/billing/billing-actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { allPlanDefinitions, resolveBillingStateForUser } from "@/lib/billing/entitlements";
import { tokenPackDefinitions } from "@/lib/billing/plans";
import { requirePageAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export default async function BillingPage() {
  const user = await requirePageAuthUser();
  const [state, transactions, usageEvents] = await Promise.all([
    resolveBillingStateForUser(user.id),
    prisma.tokenTransaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30
    }),
    prisma.usageEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30
    })
  ]);
  const plans = allPlanDefinitions();
  const canOpenPortal = Boolean(
    state.subscription &&
      (await prisma.subscription.findUnique({
        where: { userId: user.id },
        select: { billingCustomerId: true }
      }))?.billingCustomerId
  );

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold text-white md:text-4xl">Billing & Usage</h1>
          <p className="mt-1 text-sm text-zinc-300">Plan entitlements, token wallet, and usage ledger.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/pricing" className="rounded-lg border border-border/70 px-3 py-2 text-sm text-zinc-100 hover:bg-white/5">
            Public Pricing
          </Link>
          <Link href="/app" className="rounded-lg border border-border/70 px-3 py-2 text-sm text-zinc-100 hover:bg-white/5">
            Back to App
          </Link>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/70 bg-black/30">
          <CardHeader>
            <CardDescription>Current Plan</CardDescription>
            <CardTitle>{state.subscription.plan}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-300">
            Status: <span className="text-zinc-100">{state.subscription.status}</span>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-black/30">
          <CardHeader>
            <CardDescription>Monthly Tokens</CardDescription>
            <CardTitle>{state.wallet.monthlyTokensRemaining.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-300">
            Allowance: {state.wallet.monthlyAllowance.toLocaleString()}
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-black/30">
          <CardHeader>
            <CardDescription>Purchased Tokens</CardDescription>
            <CardTitle>{state.wallet.purchasedTokensRemaining.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-zinc-300">
            Total used: {state.wallet.totalTokensUsed.toLocaleString()}
          </CardContent>
        </Card>
      </section>

      <BillingActions
        plans={plans}
        tokenPacks={tokenPackDefinitions}
        currentPlan={state.subscription.plan}
        canOpenPortal={canOpenPortal}
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/70 bg-black/30">
          <CardHeader>
            <CardTitle className="text-base">Recent Token Transactions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {transactions.length === 0 ? <p className="text-zinc-400">No transactions yet.</p> : null}
            {transactions.map((txn: any) => (
              <div key={txn.id} className="rounded-lg border border-white/10 bg-black/20 p-2 text-zinc-200">
                <p className="font-medium">
                  {txn.type} {txn.amount > 0 ? "+" : ""}
                  {txn.amount}
                </p>
                <p className="text-xs text-zinc-400">
                  {txn.source} • {new Date(txn.createdAt).toLocaleString()}
                </p>
                <p className="text-xs text-zinc-300">{txn.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-black/30">
          <CardHeader>
            <CardTitle className="text-base">Recent Usage Events</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {usageEvents.length === 0 ? <p className="text-zinc-400">No usage events yet.</p> : null}
            {usageEvents.map((usage: any) => (
              <div key={usage.id} className="rounded-lg border border-white/10 bg-black/20 p-2 text-zinc-200">
                <p className="font-medium">{usage.featureKey}</p>
                <p className="text-xs text-zinc-400">
                  Estimated {usage.estimatedTokenCost} • Actual {usage.actualTokenCost ?? 0} • {usage.status}
                </p>
                <p className="text-xs text-zinc-300">{new Date(usage.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
