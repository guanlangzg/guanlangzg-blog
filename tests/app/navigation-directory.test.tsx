import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationDirectory } from '@/app/navigation/NavigationDirectory';
import type { Category } from '@/app/types/navigation';

const categories: Category[] = [
  {
    name: 'Docs',
    icon: 'folder',
    slug: 'docs',
    tools: [
      {
        title: 'MDN Web Docs',
        description: 'Web reference',
        url: 'https://developer.mozilla.org',
        icon: 'link',
        tags: ['web'],
      },
    ],
  },
];

const multipleCategories: Category[] = [
  ...categories,
  {
    name: 'AI Tools',
    icon: 'sparkles',
    slug: 'ai-tools',
    tools: [
      {
        title: 'OpenAI',
        description: 'AI platform',
        url: 'https://openai.com',
        icon: 'link',
        tags: ['ai'],
      },
    ],
  },
  {
    name: 'Design Systems',
    icon: 'palette',
    slug: 'design-systems',
    tools: [
      {
        title: 'Figma',
        description: 'Design platform',
        url: 'https://figma.com',
        icon: 'link',
        tags: ['design'],
      },
    ],
  },
];

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('NavigationDirectory', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('labels navigation search and offers a clear action for empty results', () => {
    act(() => {
      root.render(<NavigationDirectory categories={categories} totalLinkCount={1} />);
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="搜索导航链接"]');

    expect(searchInput).toBeInstanceOf(HTMLInputElement);

    act(() => {
      if (searchInput) {
        setInputValue(searchInput, 'not-found');
      }
    });

    expect(container.textContent).toContain('没有匹配的链接');
    expect(container.textContent).toContain('清空搜索并显示全部');

    const inlineClearButton = container.querySelector<HTMLButtonElement>('button[aria-label="清空搜索"]');
    const clearButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('清空搜索并显示全部')
    );

    expect(inlineClearButton).toBeInstanceOf(HTMLButtonElement);
    expect(inlineClearButton?.className).toContain('min-h-[44px]');
    expect(inlineClearButton?.className).toContain('min-w-[44px]');
    expect(inlineClearButton?.className).toContain('focus-visible:outline-2');
    expect(inlineClearButton?.className).toContain('focus-visible:outline-focus');

    act(() => {
      clearButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(searchInput?.value).toBe('');
    expect(container.textContent).toContain('MDN Web Docs');
  });

  it('makes the category filter rail discoverable and keyboard visible on mobile', () => {
    act(() => {
      root.render(<NavigationDirectory categories={multipleCategories} totalLinkCount={3} />);
    });

    const rail = container.querySelector<HTMLElement>('[aria-label="导航分类"]');
    const overflowHint = rail?.parentElement?.lastElementChild;
    const allButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.trim() === '全部'
    );
    const categoryButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Design Systems')
    );

    expect(rail).toBeInstanceOf(HTMLElement);
    expect(rail?.className).toContain('overflow-x-auto');
    expect(rail?.className).toContain('pr-9');
    expect(overflowHint?.getAttribute('aria-hidden')).toBe('true');
    expect(overflowHint?.className).toContain('bg-gradient-to-l');

    for (const button of [allButton, categoryButton]) {
      expect(button).toBeTruthy();
      expect(button?.className).toContain('min-h-[44px]');
      expect(button?.className).toContain('focus-visible:outline-2');
      expect(button?.className).toContain('focus-visible:outline-focus');
    }
  });

  it('focuses search when pressing slash outside editable fields', () => {
    act(() => {
      root.render(<NavigationDirectory categories={categories} totalLinkCount={1} />);
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="搜索导航链接"]');

    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    expect(searchInput?.getAttribute('placeholder')).toBe('搜索链接... (按 / 聚焦)');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });

    expect(searchInput).toBe(document.activeElement);
  });
});
