import { describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const mockedRevalidatePath = vi.mocked(revalidatePath);

describe('invalidatePublicContentCache', () => {
  it('revalidates every public route affected by editor data changes', () => {
    mockedRevalidatePath.mockReset();

    invalidatePublicContentCache('remote-restore');

    expect(mockedRevalidatePath.mock.calls).toEqual([
      ['/', 'layout'],
      ['/', 'page'],
      ['/blog', 'page'],
      ['/navigation', 'page'],
      ['/posts/[...slug]', 'page'],
      ['/sitemap.xml', undefined],
    ]);
  });

  it('does not let cache invalidation failures break a successful write', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockedRevalidatePath.mockReset();
    mockedRevalidatePath.mockImplementationOnce(() => {
      throw new Error('missing static generation store');
    });

    expect(() => invalidatePublicContentCache('articles-write')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to revalidate / after articles-write:'),
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });
});
