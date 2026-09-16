// Prevent static generation for auth routes.
// These pages use the Supabase browser client which requires runtime env vars.
export const dynamic = "force-dynamic";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
