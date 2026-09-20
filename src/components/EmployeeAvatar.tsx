export default function EmployeeAvatar({
  initials,
  size = "md",
}: {
  initials: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass =
    size === "lg" ? "h-14 w-14 text-lg" : size === "sm" ? "h-8 w-8 text-xs" : "h-12 w-12 text-sm";

  return (
    <div
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-xl bg-primary-50 font-semibold text-primary-700 ${sizeClass}`}
    >
      {initials}
    </div>
  );
}
