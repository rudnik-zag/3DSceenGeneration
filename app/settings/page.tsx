import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePageAuthUser } from "@/lib/auth/session";

export default async function SettingsPage() {
  const user = await requirePageAuthUser();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 md:px-6">
      <div className="flex items-center justify-between">
        <h1 className="studio-hero-title text-3xl font-medium text-white">Settings</h1>
        <Link href="/app" className="rounded-lg border border-border/70 px-3 py-2 text-sm text-zinc-100 hover:bg-white/5">
          Back to App
        </Link>
      </div>

      <Card className="border-white/[0.08] bg-[#1a1a1d]/86">
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-zinc-300">
          <p>Email: {user.email ?? "Not set"}</p>
          <p>Name: {user.name ?? "Not set"}</p>
          <p>User ID: {user.id}</p>
        </CardContent>
      </Card>
    </main>
  );
}
