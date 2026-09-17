import type { Tone } from "@/lib/format";
import StatusBadge from "@/components/StatusBadge";

const VALUE_CLASSES: Record<Tone, string> = {
  success: "text-green-600",
  warning: "text-yellow-600",
  danger: "text-red-600",
  info: "text-primary-600",
  neutral: "text-gray-900",
};

export default function DashboardStatCard({
  label,
  value,
  hint,
  tone = "neutral",
  badge,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: Tone;
  badge?: string;
}) {
  return (
    <div className="bg-white overflow-hidden shadow rounded-lg">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-gray-500">{label}</p>
          {badge && <StatusBadge label={badge} tone={tone} />}
        </div>
        <p className={`mt-2 text-2xl font-semibold ${VALUE_CLASSES[tone]}`}>
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
      </div>
    </div>
  );
}
