/**
 * Compact settings row for the Settings index.
 *
 * Three variants:
 *   - Navigation: shows a chevron and links to a sub-page.
 *   - Status: shows a value/badge on the right (read-only informational).
 *   - Text: informational row with no chevron.
 *
 * Each variant keeps a minimal touch target for mobile (py-3 px-4) while
 * maintaining the panel's existing typography and colour conventions.
 */
export default function SettingsRow({
  icon,
  label,
  description,
  value,
  tone = "neutral",
  href,
}: {
  icon: string;
  label: string;
  description?: string;
  value?: string;
  /** `neutral` = plain text, `success` = green, `warning` = yellow, `danger` = red */
  tone?: "neutral" | "success" | "warning" | "danger";
  /** When set the row is a link; otherwise it is informational. */
  href?: string;
}) {
  const toneClasses: Record<string, string> = {
    neutral: "text-gray-500",
    success: "text-green-600",
    warning: "text-yellow-600",
    danger: "text-red-600",
  };

  const content = (
    <div className="flex items-center gap-3 py-3 px-4 sm:px-5 min-h-[3rem]">
      {/* Icon */}
      <span className="text-sm flex-shrink-0 w-5 text-center" aria-hidden>
        {icon}
      </span>

      {/* Label + description */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 leading-snug">
          {label}
        </p>
        {description && (
          <p className="mt-0.5 text-xs text-gray-500 leading-snug line-clamp-1">
            {description}
          </p>
        )}
      </div>

      {/* Right side: value or chevron */}
      {value && (
        <span className={`text-xs font-medium whitespace-nowrap ${toneClasses[tone]}`}>
          {value}
        </span>
      )}
      {href && (
        <svg
          className="h-4 w-4 flex-shrink-0 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block hover:bg-gray-50 transition-colors"
      >
        {content}
      </a>
    );
  }

  return <div>{content}</div>;
}
