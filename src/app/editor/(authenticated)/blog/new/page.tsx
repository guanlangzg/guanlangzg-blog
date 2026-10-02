'use client';

import { Suspense } from 'react';
import { NewArticleContent } from './NewArticleContent';
import { EditorLoading } from '../../../components/EditorLoading';

export default function NewArticlePage() {
  return (
    <Suspense fallback={<EditorLoading />}>
      <NewArticleContent />
    </Suspense>
  );
}
