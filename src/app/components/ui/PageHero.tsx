import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeroProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  className?: string;
}

export function PageHero({
  eyebrow,
  title,
  description,
  actions,
  aside,
  className,
}: PageHeroProps) {
  const gridClass = aside
    ? 'lg:grid-cols-[minmax(0,1fr)_340px] lg:items-end'
    : 'lg:grid-cols-1';

  return (
    <section
      className={cn(
        'grid gap-5 border-b border-border pb-6 md:gap-6 md:pb-8',
        gridClass,
        className
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-3 font-mono text-xs uppercase tracking-token-caps text-accent">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="max-w-4xl text-3xl font-semibold leading-tight tracking-token-normal text-fg md:text-4xl">
          {title}
        </h1>
        {description ? (
          <div className="mt-3 max-w-2xl text-sm leading-relaxed text-muted md:text-base">
            {description}
          </div>
        ) : null}
        {actions ? (
          <div className="mt-5 flex flex-wrap gap-2.5">
            {actions}
          </div>
        ) : null}
      </div>
      {aside ? (
        <div className="lg:justify-self-end">
          {aside}
        </div>
      ) : null}
    </section>
  );
}
