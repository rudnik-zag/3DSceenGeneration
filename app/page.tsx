import { LandingPage } from "@/components/landing/landing-page";
import { getAuthSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await getAuthSession();
  const user = session?.user;

  return (
    <LandingPage
      isAuthenticated={Boolean(user?.id)}
      userLabel={user?.name ?? user?.email ?? null}
    />
  );
}
