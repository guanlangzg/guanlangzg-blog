import { Skeleton } from '@/app/components/ui';
import { EditorPage } from './EditorShell';

export function EditorLoading() {
  return (
    <EditorPage className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-52" />
        </div>
        <Skeleton className="h-10 w-28" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </EditorPage>
  );
}
