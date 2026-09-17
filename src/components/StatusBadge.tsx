import type { Tone } from "@/lib/format";

const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-green-100 text-green-800",
  warning: "bg-yellow-100 text-yellow-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-primary-100 text-primary-800",
  neutral: "bg-gray-100 text-gray-700",
};

export default function StatusBadge({
  label,
  tone = "neutral",
  title,
}: {
  label: string;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
