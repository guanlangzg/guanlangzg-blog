'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, Compass } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
    {
        text: '导航',
        href: '/navigation',
        icon: Compass,
        isActive: (pathname: string) => pathname.startsWith('/navigation'),
    },
    {
        text: '博客',
        href: '/blog',
        icon: BookOpen,
        isActive: (pathname: string) => pathname.startsWith('/blog') || pathname.startsWith('/posts'),
    },
];

export function Navigation() {
    const pathname = usePathname();

    return (
        <nav className="flex items-center gap-2" aria-label="主导航">
            {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = item.isActive(pathname);

                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        aria-label={item.text}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                            'flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-token-button border px-3 py-2 text-xs font-medium transition-colors duration-token-fast focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                            isActive
                                ? 'border-accent-300 bg-accent-50 text-accent'
                                : 'border-border bg-surface text-muted hover:border-border-focus hover:text-fg'
                        )}
                    >
                        <Icon className={cn('h-3.5 w-3.5', isActive ? 'text-accent' : 'text-subtle')} />
                        <span className="hidden sm:inline">{item.text}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
