// Force dynamic rendering for all admin routes.
// Admin pages use Supabase client which requires runtime env vars.
export const dynamic = "force-dynamic";

import AdminShell from "@/components/AdminShell";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AdminShell>{children}</AdminShell>;
}
