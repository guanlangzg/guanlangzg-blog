'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyCodeButton({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);

    async function handleCopy() {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(code);
            } else {
                const textarea = document.createElement('textarea');

                textarea.value = code;
                textarea.setAttribute('readonly', 'true');
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }

            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch (error) {
            console.error('Failed to copy code block:', error);
        }
    }

    return (
        <button
            type="button"
            className="markdown-code-block__copy"
            onClick={handleCopy}
            aria-label="复制代码"
        >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? '已复制' : '复制'}</span>
        </button>
    );
}
