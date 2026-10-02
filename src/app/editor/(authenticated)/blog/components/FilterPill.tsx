'use client';

import { X } from 'lucide-react';

export function FilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-token-badge border border-border bg-background px-2 py-1 text-xs text-muted transition hover:border-accent-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8"
      aria-label={`移除筛选：${label}`}
    >
      {label}
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
