export interface Tool {
  icon: string;
  title: string;
  description: string;
  url: string;
  tags: string[];
}

export interface Category {
  name: string;
  icon: string;
  slug: string;
  tools: Tool[];
}
