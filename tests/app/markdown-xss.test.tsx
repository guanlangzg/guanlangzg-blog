import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownContent } from '@/app/components/markdown/MarkdownContent';

describe('Markdown XSS Protection', () => {
  const xssPayloads = [
    {
      name: 'javascript: protocol in link',
      payload: '[click me](javascript:alert(1))',
      shouldNotContain: ['javascript:', 'alert(1)'],
    },
    {
      name: 'data: protocol with script',
      payload: '[link](data:text/html,<script>alert(1)</script>)',
      shouldNotContain: ['data:text/html', '<script>', 'alert(1)'],
    },
    {
      name: 'HTML img with onerror',
      payload: '<img src=x onerror=alert(1)>',
      shouldNotContain: ['onerror', 'alert(1)', '<img'],
    },
    {
      name: 'HTML iframe',
      payload: '<iframe src="https://evil.com"></iframe>',
      shouldNotContain: ['<iframe', 'evil.com'],
    },
    {
      name: 'HTML script tag',
      payload: '<script>alert(1)</script>',
      shouldNotContain: ['<script>', 'alert(1)'],
    },
    {
      name: 'HTML object tag',
      payload: '<object data="javascript:alert(1)"></object>',
      shouldNotContain: ['<object', 'javascript:', 'alert(1)'],
    },
    {
      name: 'HTML embed tag',
      payload: '<embed src="javascript:alert(1)">',
      shouldNotContain: ['<embed', 'javascript:', 'alert(1)'],
    },
    {
      name: 'HTML with onclick',
      payload: '<div onclick="alert(1)">Click</div>',
      shouldNotContain: ['onclick', 'alert(1)'],
    },
    {
      name: 'style tag with CSS injection',
      payload: '<style>body { background: url("javascript:alert(1)") }</style>',
      shouldNotContain: ['<style>', 'javascript:', 'alert(1)'],
    },
    {
      name: 'SVG with script',
      payload: '<svg><script>alert(1)</script></svg>',
      shouldNotContain: ['<svg>', '<script>'],
    },
  ];

  xssPayloads.forEach(({ name, payload, shouldNotContain }) => {
    it(`should sanitize: ${name}`, () => {
      const { container } = render(<MarkdownContent content={payload} />);
      const html = container.innerHTML.toLowerCase();

      shouldNotContain.forEach((dangerous) => {
        expect(html).not.toContain(dangerous.toLowerCase());
      });

      // 验证没有可执行的 script
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('object')).toBeNull();
      expect(container.querySelector('embed')).toBeNull();
    });
  });

  describe('Safe content rendering', () => {
    it('should render normal links safely', () => {
      const { container } = render(
        <MarkdownContent content="[GitHub](https://github.com)" />
      );

      const link = container.querySelector('a');
      expect(link).not.toBeNull();
      expect(link?.getAttribute('href')).toBe('https://github.com');
      expect(link?.textContent).toBe('GitHub');
    });

    it('should render code blocks safely', () => {
      const { container } = render(
        <MarkdownContent content="```js\nconst x = 1;\n```" />
      );

      // 检查文本内容包含代码
      expect(container.textContent).toContain('const x = 1;');

      // 验证没有执行脚本
      expect(container.querySelector('script')).toBeNull();
    });

    it('should render inline code safely', () => {
      const { container } = render(
        <MarkdownContent content="`const x = 1;`" />
      );

      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code?.textContent).toBe('const x = 1;');
    });

    it('should render images with https/http only', () => {
      const { container } = render(
        <MarkdownContent content="![alt](https://example.com/image.png)" />
      );

      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://example.com/image.png');
      expect(img?.getAttribute('alt')).toBe('alt');
    });

    it('should render tables safely', () => {
      const markdown = `
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
      `;

      const { container } = render(<MarkdownContent content={markdown} />);

      const table = container.querySelector('table');
      expect(table).not.toBeNull();

      const headers = container.querySelectorAll('th');
      expect(headers.length).toBe(2);
      expect(headers[0]?.textContent).toBe('Header 1');
    });
  });

  describe('Protocol filtering', () => {
    const dangerousProtocols = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ];

    dangerousProtocols.forEach((protocol) => {
      it(`should block dangerous protocol: ${protocol.split(':')[0]}`, () => {
        const { container } = render(
          <MarkdownContent content={`[link](${protocol})`} />
        );

        const link = container.querySelector('a');
        if (link) {
          const href = link.getAttribute('href') || '';
          expect(href.toLowerCase()).not.toContain(protocol.split(':')[0]);
        }
      });
    });
  });

  describe('skipHtml configuration', () => {
    it('should strip raw HTML tags', () => {
      const content = `
# Heading

<div class="dangerous">This is raw HTML</div>

Normal text
      `;

      const { container } = render(<MarkdownContent content={content} />);
      const html = container.innerHTML;

      // HTML 标签应该被移除
      expect(html).not.toContain('<div class="dangerous">');
      // 但 markdown-preview 容器的 </div> 会存在，只检查危险的内容
      expect(html).not.toContain('class="dangerous"');
    });

    it('should preserve markdown-generated HTML', () => {
      const { container } = render(<MarkdownContent content="**bold**" />);

      const strong = container.querySelector('strong');
      expect(strong).not.toBeNull();
      expect(strong?.textContent).toBe('bold');
    });
  });

  describe('Code block safety', () => {
    it('should not execute code in code blocks', () => {
      const dangerousCode = '```js\nalert("XSS")\n```';
      const { container } = render(<MarkdownContent content={dangerousCode} />);

      // 代码应该被渲染为文本，不应执行
      expect(container.textContent).toContain('alert("XSS")');

      // 不应有实际的 script 标签
      expect(container.querySelector('script')).toBeNull();
    });

    it('should handle HTML in code blocks as text', () => {
      const htmlInCode = '```html\n<script>alert(1)</script>\n```';
      const { container } = render(<MarkdownContent content={htmlInCode} />);

      // HTML 应该被转义为文本
      expect(container.textContent).toContain('<script>alert(1)</script>');

      // 不应有实际的 script 元素
      expect(container.querySelector('script')).toBeNull();
    });
  });
});
