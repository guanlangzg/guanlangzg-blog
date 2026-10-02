import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BlogLoading from '@/app/blog/loading';
import Loading from '@/app/loading';
import NavigationLoading from '@/app/navigation/loading';
import PostLoading from '@/app/posts/[...slug]/loading';

describe('Loading', () => {
  it('announces the loading state politely', () => {
    const { getByRole } = render(<Loading />);
    const status = getByRole('status');

    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('loading...');
  });

  it('announces route skeleton loading states politely', () => {
    [
      { Component: BlogLoading, label: '正在加载博客列表...' },
      { Component: NavigationLoading, label: '正在加载导航目录...' },
      { Component: PostLoading, label: '正在加载文章内容...' },
    ].forEach(({ Component, label }) => {
      const { getByRole, unmount } = render(<Component />);
      const status = getByRole('status');

      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveTextContent(label);
      unmount();
    });
  });
});
