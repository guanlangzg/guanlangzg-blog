'use client';

import { cn } from '@/lib/utils';

function MetricContent({ label, value, active }: { label: string; value: number; active: boolean }) {
  return (
    <>
      <p className={cn('font-mono text-xs', active ? 'text-accent' : 'text-subtle')}>{label}</p>
      <p className={cn('mt-2 text-2xl font-semibold', active ? 'text-accent' : 'text-fg')}>{value}</p>
    </>
  );
}

export function AssetMetric({
  label,
  value,
  active = false,
  onClick,
}: {
  label: string;
  value: number;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = cn(
    'rounded-token-card border p-4 text-left shadow-token-card transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    active
      ? 'border-accent-300 bg-accent-50 text-accent shadow-token-md'
      : 'border-border bg-surface text-fg hover:border-accent-200 hover:bg-accent-50/50'
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={className}
        aria-pressed={active}
      >
        <MetricContent label={label} value={value} active={active} />
      </button>
    );
  }

  return (
    <div className={className}>
      <MetricContent label={label} value={value} active={active} />
    </div>
  );
}
