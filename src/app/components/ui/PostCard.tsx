import { cn } from '@/lib/utils';
import { ArrowRight } from 'lucide-react';

interface PostCardProps {
    title: string;
    description?: string;
    date?: string;
    href: string;
    className?: string;
}

export function PostCard({ title, description, date, href, className }: PostCardProps) {
    return (
        <a
            href={href}
            className={cn(
                "group relative block overflow-hidden rounded-token-card border border-border bg-surface-elevated p-4 pr-12",
                "transition-all duration-token-normal ease-token-out",
                "hover:-translate-y-0.5 hover:border-accent-300 hover:bg-accent-50/40 hover:shadow-token-card-hover active:translate-y-0",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                className
            )}
        >
            <span className="absolute inset-y-0 left-0 w-1 bg-accent opacity-0 transition-opacity duration-token-fast group-hover:opacity-100 group-focus-visible:opacity-100" />
            <div className="flex flex-col justify-between gap-2.5 md:flex-row md:items-center">
                <div className="flex-1 min-w-0">
                    <h3 className="text-base font-semibold text-fg transition-colors duration-token-fast group-hover:text-accent">
                        {title}
                    </h3>
                    {description && (
                        <p className="mt-1 text-sm leading-relaxed text-muted line-clamp-1">
                            {description}
                        </p>
                    )}
                </div>
                {date && (
                    <time className="shrink-0 rounded-token-badge bg-surface px-2.5 py-1 font-mono text-xs text-subtle border border-border">
                        {date}
                    </time>
                )}
            </div>
            <span className="absolute right-4 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-token-button border border-border-soft bg-surface text-subtle transition-all duration-token-fast group-hover:translate-x-1 group-hover:border-accent-200 group-hover:text-accent">
                <ArrowRight className="h-4 w-4" />
            </span>
        </a>
    );
}
