import { TypewriterLogo } from './TypewriterLogo';
import { CommandInput } from './CommandInput';
import { StatusIndicator } from './StatusIndicator';
import { Navigation } from './Navigation';
import { ThemeToggle } from '../theme/ThemeToggle';

export function Header() {
    return (
        <header className="sticky top-0 z-token-sticky w-full border-b border-border bg-[var(--header-bg)] backdrop-blur-xl shadow-token-header">
            <div className="mx-auto flex h-14 max-w-token-wide items-center justify-between gap-4 px-4 sm:px-6">
                <TypewriterLogo />

                <div className="hidden flex-1 justify-center lg:flex">
                    <CommandInput />
                </div>

                <div className="flex items-center gap-2 sm:gap-3">
                    <CommandInput compact className="lg:hidden" />
                    <div className="hidden sm:block">
                        <StatusIndicator />
                    </div>
                    <ThemeToggle compact />
                    <Navigation />
                </div>
            </div>
        </header>
    );
}
