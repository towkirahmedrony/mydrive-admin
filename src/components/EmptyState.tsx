export default function EmptyState({
  icon = "—",
  title,
  detail,
}: {
  icon?: string;
  title: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-gray-200 bg-gray-50 px-6 py-8 text-center">
      <div className="text-2xl" aria-hidden>
        {icon}
      </div>
      <p className="mt-2 text-sm font-medium text-gray-700">{title}</p>
      {detail && <p className="mt-1 text-xs text-gray-500">{detail}</p>}
    </div>
  );
}
