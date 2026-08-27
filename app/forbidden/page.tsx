import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center studio-dot-bg p-6">
      <div className="w-full max-w-lg rounded-xl border border-white/[0.08] bg-[#1a1a1d]/86 p-8">
        <h1 className="studio-hero-title text-2xl font-medium text-white">403 - Access Denied</h1>
        <p className="mt-2 text-sm text-zinc-300">
          You do not have permission to access this resource.
        </p>
        <div className="mt-5 flex gap-3">
          <Button asChild>
            <Link href="/app">Back to Dashboard</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Sign In</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
