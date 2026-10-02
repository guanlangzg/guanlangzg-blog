import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FileQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon: Icon = FileQuestion,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-token-card border border-dashed border-border bg-surface px-5 py-8 text-center',
        className
      )}
    >
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-token-card border border-border-soft bg-bg text-subtle">
        <Icon className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-base font-medium text-fg">{title}</h2>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
