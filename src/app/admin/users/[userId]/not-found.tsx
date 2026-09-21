import Link from "next/link";

/**
 * Shown for an unknown employee id and for a caller who is not allowed to read
 * the record. Both cases look identical on purpose: an authenticated non-admin
 * must not be able to probe which employee ids exist.
 */
export default function EmployeeNotFound() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm sm:p-10">
      <h1 className="text-lg font-semibold text-gray-900 sm:text-xl">
        Employee not found
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
        This employee record does not exist, or your account is not allowed to
        open it.
      </p>
      <Link
        href="/admin/users"
        className="mt-5 inline-flex items-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500"
      >
        Back to Users
      </Link>
    </div>
  );
}
