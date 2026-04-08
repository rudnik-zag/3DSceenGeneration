import { AppShell } from "@/components/layout/app-shell";
import { requirePageAuthUser } from "@/lib/auth/session";

export default async function AppLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageAuthUser();

  return <AppShell currentUserLabel={user.email ?? user.name ?? user.id}>{children}</AppShell>;
}
