import Link from "next/link";

import { allPlanDefinitions } from "@/lib/billing/entitlements";
import { tokenPackDefinitions } from "@/lib/billing/plans";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function PricingPage() {
  const plans = allPlanDefinitions();

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-4 py-10 md:px-6">
      <div className="mb-8">
        <h1 className="text-4xl font-semibold tracking-tight text-white md:text-5xl">Pricing</h1>
        <p className="mt-3 max-w-3xl text-sm text-zinc-300 md:text-base">
          Subscription includes monthly tokens. Extra token packs can be purchased anytime.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/register">Get Started</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Login</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/">Back to Landing</Link>
          </Button>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => (
          <Card key={plan.key} className="rounded-2xl border-border/70 bg-black/35">
            <CardHeader>
              <CardTitle className="text-white">{plan.title}</CardTitle>
              <CardDescription>{plan.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-zinc-200">
              <p className="text-2xl font-semibold text-white">
                {plan.monthlyPriceUsd === 0 ? "Free" : `$${plan.monthlyPriceUsd}/mo`}
              </p>
              <p>{plan.entitlements.monthlyTokenAllowance.toLocaleString()} monthly tokens</p>
              <p>Projects: up to {plan.entitlements.maxProjects}</p>
              <p>Storage: {plan.entitlements.maxStorageGb}GB</p>
              <p>Upload limit: {plan.entitlements.maxUploadMb}MB/file</p>
              <p>Concurrent runs: {plan.entitlements.maxConcurrentRuns}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-10">
        <h2 className="mb-4 text-2xl font-semibold text-white">Token Packs</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {tokenPackDefinitions.map((pack) => (
            <Card key={pack.key} className="rounded-2xl border-border/70 bg-black/35">
              <CardHeader>
                <CardTitle className="text-white">{pack.title}</CardTitle>
                <CardDescription>{pack.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm text-zinc-200">
                <p className="text-xl font-semibold text-white">{pack.tokens.toLocaleString()} tokens</p>
                <p>${pack.priceUsd} one-time</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
