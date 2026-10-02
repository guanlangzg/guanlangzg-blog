'use client';

import { useEffect, useRef, useState } from 'react';

function joinTagKey(tags: string[]): string {
  return tags.join('\u0000');
}

/**
 * Text input state for comma-separated tags. The raw text stays local so a
 * freshly typed separator survives the controlled-input roundtrip (parsing
 * "a," back to ["a"] and re-joining would otherwise eat the comma), while the
 * parsed tags are committed to the form on every change. External tag updates
 * (template applied, conflict reload) still re-sync the text.
 */
export function useTagsText(
  sourceTags: string[],
  commit: (tags: string[]) => void
): [string, (nextText: string) => void] {
  const [tagsText, setTagsText] = useState(() => sourceTags.join(', '));
  const committedTagsRef = useRef(sourceTags);

  useEffect(() => {
    if (joinTagKey(sourceTags) !== joinTagKey(committedTagsRef.current)) {
      committedTagsRef.current = sourceTags;
      setTagsText(sourceTags.join(', '));
    }
  }, [sourceTags]);

  const handleTagsTextChange = (nextText: string) => {
    setTagsText(nextText);
    const parsedTags = nextText.split(',').map((tag) => tag.trim()).filter(Boolean);
    committedTagsRef.current = parsedTags;
    commit(parsedTags);
  };

  return [tagsText, handleTagsTextChange];
}
