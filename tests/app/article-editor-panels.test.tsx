import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WritingInspector } from '@/app/editor/(authenticated)/blog/new/ArticleEditorPanels';
import type { ArticleQualityCheck } from '@/lib/article-quality';

describe('WritingInspector', () => {
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

  it('turns failed quality checks into focusable repair actions', () => {
    const failedCheck: ArticleQualityCheck = {
      id: 'title-required',
      label: '标题已填写',
      severity: 'blocking',
      passed: false,
    };
    const passedCheck: ArticleQualityCheck = {
      id: 'date-valid',
      label: '发布日期有效',
      severity: 'blocking',
      passed: true,
    };
    const onResolveCheck = vi.fn();

    act(() => {
      root.render(
        <WritingInspector
          draftSavedAt={null}
          headings={[]}
          isDirty={false}
          isPersisted
          onJumpToHeading={() => {}}
          onResolveCheck={onResolveCheck}
          qualityChecks={[failedCheck, passedCheck]}
          readingMinutes={1}
          wordCount={0}
        />
      );
    });

    const repairButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('标题已填写')
    );

    expect(repairButton).toBeTruthy();
    expect(container.textContent).toContain('点击定位');

    act(() => {
      repairButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onResolveCheck).toHaveBeenCalledWith(failedCheck);
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('发布日期有效')
      )
    ).toBe(false);
  });

  it('distinguishes unsaved new articles from persisted clean content', () => {
    const qualityChecks: ArticleQualityCheck[] = [];

    act(() => {
      root.render(
        <WritingInspector
          draftSavedAt={null}
          headings={[]}
          isDirty={false}
          isPersisted={false}
          onJumpToHeading={() => {}}
          qualityChecks={qualityChecks}
          readingMinutes={1}
          wordCount={8}
        />
      );
    });

    expect(container.textContent).toContain('尚未保存到文章库');
    expect(container.textContent).not.toContain('内容已保存');

    act(() => {
      root.render(
        <WritingInspector
          draftSavedAt={null}
          headings={[]}
          isDirty={false}
          isPersisted
          onJumpToHeading={() => {}}
          qualityChecks={qualityChecks}
          readingMinutes={1}
          wordCount={8}
        />
      );
    });

    expect(container.textContent).toContain('内容已保存');
  });
});
