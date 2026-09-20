import Link from "next/link";

export default function EmployeeNotFound() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
      <h1 className="text-xl font-semibold text-gray-900">Employee not found</h1>
      <p className="mt-2 text-sm text-gray-500">
        This employee folder does not exist, or you are not allowed to open it.
      </p>
      <Link
        href="/admin/media"
        className="mt-6 inline-flex items-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500"
      >
        Back to Employees
      </Link>
    </div>
  );
}
