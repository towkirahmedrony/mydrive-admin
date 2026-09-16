export default function UsersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage application users and their devices
        </p>
      </div>

      <div className="bg-white shadow rounded-lg p-12 text-center">
        <div className="text-4xl mb-4">👥</div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          Coming Soon
        </h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto">
          User management and device administration will be available in a future
          update. This feature is part of Phase 4 development.
        </p>
      </div>
    </div>
  );
}
