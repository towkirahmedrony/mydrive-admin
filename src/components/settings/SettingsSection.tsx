/**
 * Settings section wrapper — compact card with an icon header.
 *
 * Used by the settings index page to group related rows into visually
 * distinct, scannable sections. Matches the project's existing
 * `bg-white shadow rounded-lg` card convention.
 */
export default function SettingsSection({
  icon,
  title,
  subtitle,
  linkHref,
  linkLabel,
  children,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  linkHref?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white shadow rounded-lg overflow-hidden">
      <div className="px-4 py-3 sm:px-5 border-b border-gray-100 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-base flex-shrink-0" aria-hidden>
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
            )}
          </div>
        </div>
        {linkHref && linkLabel && (
          <a
            href={linkHref}
            className="text-xs font-medium text-primary-600 hover:text-primary-500 whitespace-nowrap flex-shrink-0"
          >
            {linkLabel} →
          </a>
        )}
      </div>
      <div className="divide-y divide-gray-50">{children}</div>
    </section>
  );
}
