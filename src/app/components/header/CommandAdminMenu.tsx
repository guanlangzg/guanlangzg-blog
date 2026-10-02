'use client';

import { useRouter } from 'next/navigation';
import { Compass, FileText, KeyRound, Lock, Settings } from 'lucide-react';

export type EditorAuthStatus = {
  configured: boolean;
  authenticated: boolean;
  setupEnabled: boolean;
  setupTokenRequired: boolean;
};

export function CommandAdminMenu({
  status,
  isLoading,
  error,
  onClose,
}: {
  status: EditorAuthStatus | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const router = useRouter();

  return (
    <div className="border-t border-border-soft">
      <div className="px-4 py-2 bg-surface border-b border-border-soft">
        <div className="flex items-center gap-2 text-sm font-mono text-muted">
          <Lock className="w-4 h-4 text-warning" />
          <span>受保护编辑区</span>
        </div>
      </div>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-sm font-mono text-subtle">
          <span className="animate-pulse">检查编辑区状态...</span>
        </div>
      ) : error ? (
        <div className="px-4 py-6 text-sm leading-6 text-danger">
          {error}
        </div>
      ) : status && !status.configured ? (
        <div className="p-2">
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push('/setup');
            }}
            className="flex min-h-[44px] w-full cursor-pointer items-start gap-3 rounded-token-card px-3 py-2.5 transition-colors duration-token-fast hover:bg-surface"
          >
            <KeyRound className="w-4 h-4 text-subtle mt-0.5 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium text-fg">初次使用初始化引导</div>
              <div className="text-xs leading-5 text-subtle">
                {status.setupEnabled
                  ? '设置编辑口令后进入后台'
                  : '服务器需先开启首次初始化'}
              </div>
            </div>
          </button>
        </div>
      ) : (
        <div className="p-2 space-y-1">
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push('/editor/blog');
            }}
            className="flex min-h-[44px] w-full cursor-pointer items-start gap-3 rounded-token-card px-3 py-2.5 transition-colors duration-token-fast hover:bg-surface"
          >
            <FileText className="w-4 h-4 text-subtle mt-0.5 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium text-fg">写文章</div>
              <div className="text-xs text-subtle">创建新的博客文章</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push('/editor/navigation');
            }}
            className="flex min-h-[44px] w-full cursor-pointer items-start gap-3 rounded-token-card px-3 py-2.5 transition-colors duration-token-fast hover:bg-surface"
          >
            <Compass className="w-4 h-4 text-subtle mt-0.5 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium text-fg">编辑导航</div>
              <div className="text-xs text-subtle">管理导航链接和分类</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push('/editor/settings');
            }}
            className="flex min-h-[44px] w-full cursor-pointer items-start gap-3 rounded-token-card px-3 py-2.5 transition-colors duration-token-fast hover:bg-surface"
          >
            <Settings className="w-4 h-4 text-subtle mt-0.5 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium text-fg">站点设置</div>
              <div className="text-xs text-subtle">管理公开站点信息</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
