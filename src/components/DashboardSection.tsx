import Link from "next/link";

/**
 * Card wrapper used by every dashboard section, matching the panel's existing
 * `bg-white shadow rounded-lg` card style.
 */
export default function DashboardSection({
  title,
  description,
  linkHref,
  linkLabel,
  children,
}: {
  title: string;
  description?: string;
  /** Only set for routes that actually exist and show relevant content. */
  linkHref?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white shadow rounded-lg overflow-hidden">
      <div className="px-4 py-5 sm:px-6 border-b border-gray-200 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-gray-500">{description}</p>
          )}
        </div>
        {linkHref && linkLabel && (
          <Link
            href={linkHref}
            className="text-sm font-medium text-primary-600 hover:text-primary-500 whitespace-nowrap"
          >
            {linkLabel} →
          </Link>
        )}
      </div>
      <div className="px-4 py-5 sm:px-6">{children}</div>
    </section>
  );
}
