import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontmatterForm } from '@/app/editor/(authenticated)/blog/components/FrontmatterForm';
import type { Frontmatter } from '@/app/types/article';
import type { ArticleQualityCheck } from '@/lib/article-quality';

describe('FrontmatterForm', () => {
  let container: HTMLDivElement;
  let root: Root;

  const frontmatter: Frontmatter = {
    title: '',
    date: '2026-05-27',
    description: '',
    tags: [],
    status: 'published',
    kind: 'essay',
  };

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

  it('renders field-level publishing feedback beside affected metadata inputs', () => {
    const titleCheck: ArticleQualityCheck = {
      id: 'title-required',
      label: '标题已填写',
      severity: 'blocking',
      passed: false,
    };
    const tagsCheck: ArticleQualityCheck = {
      id: 'tags-present',
      label: '至少有 1 个标签',
      severity: 'warning',
      passed: false,
    };

    act(() => {
      root.render(
        <FrontmatterForm
          value={frontmatter}
          onChange={() => {}}
          qualityChecks={{
            title: [titleCheck],
            tags: [tagsCheck],
          }}
        />
      );
    });

    const titleInput = container.querySelector<HTMLInputElement>('#frontmatter-title');
    const tagsInput = container.querySelector<HTMLInputElement>('#frontmatter-tags');

    expect(titleInput?.getAttribute('aria-invalid')).toBe('true');
    expect(titleInput?.getAttribute('aria-describedby')).toBe('frontmatter-title-feedback');
    expect(tagsInput?.getAttribute('aria-invalid')).toBe('false');
    expect(tagsInput?.getAttribute('aria-describedby')).toBe('frontmatter-tags-feedback');
    expect(container.textContent).toContain('发布阻塞：请填写标题');
    expect(container.textContent).toContain('发布建议：至少添加 1 个标签');
  });

  it('exposes a stable focus target for featured publishing feedback', () => {
    act(() => {
      root.render(
        <FrontmatterForm
          value={{ ...frontmatter, featured: true }}
          onChange={() => {}}
          qualityChecks={{
            featured: [
              {
                id: 'featured-public',
                label: '精选内容不是草稿',
                severity: 'blocking',
                passed: false,
              },
            ],
          }}
        />
      );
    });

    const featuredInput = container.querySelector<HTMLInputElement>('#frontmatter-featured');

    expect(featuredInput).toBeInstanceOf(HTMLInputElement);
    expect(featuredInput?.getAttribute('aria-invalid')).toBe('true');
    expect(featuredInput?.getAttribute('aria-describedby')).toBe('frontmatter-featured-feedback');
  });

  it('previews the public post path and can generate a slug from the title', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <FrontmatterForm
          value={{
            ...frontmatter,
            title: 'Hello Runtime Notes!',
            slug: '',
          }}
          onChange={onChange}
        />
      );
    });

    expect(container.textContent).toContain('/posts/hello-runtime-notes');
    expect(container.textContent).toContain('留空时保存会按标题和文章 ID 自动生成稳定 URL');

    const generateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('从标题生成')
    );

    act(() => {
      generateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'hello-runtime-notes',
      })
    );
  });

  it('summarizes publishing metadata before the detailed fields', () => {
    act(() => {
      root.render(
        <FrontmatterForm
          value={{
            ...frontmatter,
            description: '这是一段足够长的描述，用来验证发布准备摘要的字符数显示。',
            slug: 'runtime-summary',
            tags: ['design', 'editor'],
            sourceLinks: [
              { title: 'Docs', url: 'https://example.com/docs' },
            ],
          }}
          onChange={() => {}}
        />
      );
    });

    expect(container.textContent).toContain('发布准备');
    expect(container.textContent).toContain('状态、路径和摘要会影响公开页展示。');
    expect(container.textContent).toContain('已发布');
    expect(container.textContent).toContain('2 个');
    expect(container.textContent).toContain('/posts/runtime-summary');
    expect(container.textContent).toContain('1 条');
  });

  it('surfaces unsafe source URLs in the publishing summary', () => {
    act(() => {
      root.render(
        <FrontmatterForm
          value={{
            ...frontmatter,
            sourceLinks: [{ title: 'Bad Source', url: 'javascript:alert(1)' }],
          }}
          onChange={() => {}}
          qualityChecks={{
            sourceLinks: [
              {
                id: 'source-url-valid',
                label: '参考资料链接安全有效',
                severity: 'blocking',
                passed: false,
              },
            ],
          }}
        />
      );
    });

    expect(container.textContent).toContain('1 阻塞');
    expect(container.textContent).toContain('需修正');
  });

  it('disables slug generation until a title exists', () => {
    act(() => {
      root.render(
        <FrontmatterForm
          value={{ ...frontmatter, title: '', slug: '' }}
          onChange={() => {}}
        />
      );
    });

    const generateButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('从标题生成')
    );

    expect(generateButton).toBeInstanceOf(HTMLButtonElement);
    expect((generateButton as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('/posts/article-id');
  });

  it('keeps a freshly typed comma in the tags input', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(<FrontmatterForm value={{ ...frontmatter, tags: [] }} onChange={onChange} />);
    });

    const tagsInput = container.querySelector<HTMLInputElement>('#frontmatter-tags');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    act(() => {
      valueSetter?.call(tagsInput, 'a');
      tagsInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['a'] }));

    // The parent commits the parsed tags back through props; the text must not
    // be reformatted mid-typing.
    act(() => {
      root.render(<FrontmatterForm value={{ ...frontmatter, tags: ['a'] }} onChange={onChange} />);
    });

    expect(tagsInput?.value).toBe('a');

    act(() => {
      valueSetter?.call(tagsInput, 'a,');
      tagsInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['a'] }));
    expect(tagsInput?.value).toBe('a,');
  });

  it('edits source links as repeatable metadata fields', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <FrontmatterForm
          value={frontmatter}
          onChange={onChange}
        />
      );
    });

    const addSourceButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('添加资料')
    );

    act(() => {
      addSourceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLinks: [{ title: '', url: '', note: '' }],
      })
    );

    onChange.mockClear();

    act(() => {
      root.render(
        <FrontmatterForm
          value={{
            ...frontmatter,
            sourceLinks: [{ title: '', url: '', note: '' }],
          }}
          onChange={onChange}
        />
      );
    });

    const sourceTitleInput = container.querySelector<HTMLInputElement>('#frontmatter-source-title-0');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    act(() => {
      valueSetter?.call(sourceTitleInput, 'Official Docs');
      sourceTitleInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLinks: [{ title: 'Official Docs', url: '', note: '' }],
      })
    );
  });

  it('shows inline feedback for unsafe source URLs', () => {
    act(() => {
      root.render(
        <FrontmatterForm
          value={{
            ...frontmatter,
            sourceLinks: [{ title: 'Bad Source', url: 'javascript:alert(1)', note: '' }],
          }}
          onChange={() => {}}
        />
      );
    });

    const sourceUrlInput = container.querySelector<HTMLInputElement>('#frontmatter-source-url-0');

    expect(sourceUrlInput?.getAttribute('aria-invalid')).toBe('true');
    expect(sourceUrlInput?.getAttribute('aria-describedby')).toBe('frontmatter-source-url-0-description');
    expect(sourceUrlInput?.type).toBe('url');
    expect(sourceUrlInput?.inputMode).toBe('url');
    expect(sourceUrlInput?.getAttribute('autocapitalize')).toBe('none');
    expect(sourceUrlInput?.getAttribute('autocorrect')).toBe('off');
    expect(sourceUrlInput?.getAttribute('spellcheck')).toBe('false');
    expect(container.textContent).toContain('请输入有效的 HTTPS 链接。');
  });

  it('edits revision notes as repeatable metadata fields', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <FrontmatterForm
          value={{ ...frontmatter, updatedDate: '2026-05-28' }}
          onChange={onChange}
        />
      );
    });

    const addRevisionButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('添加修订')
    );

    act(() => {
      addRevisionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        revisionNotes: [{ date: '2026-05-28', note: '' }],
      })
    );

    onChange.mockClear();

    act(() => {
      root.render(
        <FrontmatterForm
          value={{
            ...frontmatter,
            revisionNotes: [{ date: '2026-05-28', note: 'Initial note' }],
          }}
          onChange={onChange}
        />
      );
    });

    const deleteRevisionButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('删除修订')
    );

    act(() => {
      deleteRevisionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        revisionNotes: [],
      })
    );
  });
});
