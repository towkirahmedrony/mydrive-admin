"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function EmployeeSearch({ defaultValue }: { defaultValue: string }) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed === defaultValue) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (trimmed) params.set("q", trimmed);
      const next = params.size ? `/admin/media?${params.toString()}` : "/admin/media";
      router.push(next);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [value, defaultValue, router]);

  return (
    <form action="/admin/media" method="get" className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <label className="block">
        <span className="sr-only">Search employees</span>
        <input
          name="q"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search employees by name, email, or designation"
          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none ring-primary-500 placeholder:text-gray-400 focus:ring-2"
        />
      </label>
    </form>
  );
}
