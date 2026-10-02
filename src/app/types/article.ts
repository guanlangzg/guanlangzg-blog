export type ArticleKind =
  | 'essay'
  | 'guide'
  | 'deep-dive'
  | 'til'
  | 'debug'
  | 'project'
  | 'resource'
  | 'link'
  | 'review'
  | 'release';

export type ArticleStatus =
  | 'draft'
  | 'seedling'
  | 'published'
  | 'evergreen'
  | 'archived';

export type ArticleTemplateGroup = 'quick' | 'deep' | 'review' | 'entry';

export type QualityRuleSeverity = 'blocking' | 'warning' | 'suggestion';

export interface ArticleSourceLink {
  title: string;
  url: string;
  note?: string;
}

export interface ArticleRevisionNote {
  date: string;
  note: string;
}

export interface ArticleQualityRule {
  id: string;
  label: string;
  severity: QualityRuleSeverity;
}

export interface Article {
  id: string;
  slug?: string;
  title: string;
  date: string;
  description: string;
  tags: string[];
  content: string;
  createdAt: number;
  updatedAt: number;
  kind?: ArticleKind;
  status?: ArticleStatus;
  category?: string;
  series?: string;
  featured?: boolean;
  updatedDate?: string;
  sourceLinks?: ArticleSourceLink[];
  revisionNotes?: ArticleRevisionNote[];
  templateId?: string;
}

export interface ArticleTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category?: string;
  group?: ArticleTemplateGroup;
  kind?: ArticleKind;
  defaultStatus?: ArticleStatus;
  estimatedMinutes?: number;
  highlights?: string[];
  bestFor?: string[];
  output?: string;
  requiredSections?: string[];
  qualityRules?: ArticleQualityRule[];
  frontmatter: {
    title: string;
    description: string;
    tags: string[];
    kind?: ArticleKind;
    status?: ArticleStatus;
    category?: string;
    series?: string;
    featured?: boolean;
    updatedDate?: string;
    sourceLinks?: ArticleSourceLink[];
    revisionNotes?: ArticleRevisionNote[];
  };
  content: string;
}

export interface Frontmatter {
  title: string;
  slug?: string;
  date: string;
  updatedDate?: string;
  description: string;
  kind?: ArticleKind;
  status?: ArticleStatus;
  category?: string;
  series?: string;
  featured?: boolean;
  tags: string[];
  sourceLinks?: ArticleSourceLink[];
  revisionNotes?: ArticleRevisionNote[];
  templateId?: string;
}
