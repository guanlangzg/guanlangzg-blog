import type { HTMLAttributes, ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'loading';

interface StatusMessageProps extends HTMLAttributes<HTMLDivElement> {
  tone?: StatusTone;
  children: ReactNode;
}

const toneClass: Record<StatusTone, string> = {
  info: 'border-border bg-surface text-muted',
  success: 'border-success-light bg-green-50 text-fg',
  warning: 'border-warning-light bg-warning-50 text-fg',
  danger: 'border-danger-light bg-red-50 text-fg',
  loading: 'border-border bg-surface text-muted',
};

const iconMap = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  danger: AlertCircle,
  loading: Loader2,
};

export function StatusMessage({
  tone = 'info',
  children,
  className,
  ...props
}: StatusMessageProps) {
  const Icon = iconMap[tone];

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-token-card border px-4 py-3 text-sm leading-relaxed',
        toneClass[tone],
        className
      )}
      role={tone === 'danger' ? 'alert' : 'status'}
      {...props}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'loading' ? 'animate-spin' : '')} />
      <div>{children}</div>
    </div>
  );
}
