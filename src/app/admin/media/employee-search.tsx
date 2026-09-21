"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function EmployeeSearch({
  defaultValue,
  compact = false,
}: {
  defaultValue: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(Boolean(defaultValue));

  useEffect(() => {
    setValue(defaultValue);
    if (defaultValue) setOpen(true);
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

  if (compact) {
    return (
      <div className="relative">
        <button
          type="button"
          aria-label="Search employees"
          title="Search employees"
          onClick={() => setOpen((current) => !current)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path strokeLinecap="round" d="m16 16 4 4" />
          </svg>
        </button>
        {open && (
          <div className="absolute right-0 top-11 z-20 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
            <label>
              <span className="sr-only">Search employees</span>
              <input
                autoFocus
                name="q"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Search name, email, or role"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none ring-primary-500 placeholder:text-gray-400 focus:ring-2"
              />
            </label>
          </div>
        )}
      </div>
    );
  }

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
