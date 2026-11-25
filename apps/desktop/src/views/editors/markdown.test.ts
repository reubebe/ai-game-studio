import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings, lists, code and links", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** `code`.\n\n- one\n- two\n\n```\nx < y\n```\n[site](https://example.org)");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>two</li>");
    expect(html).toContain("<pre><code>x &lt; y</code></pre>");
    expect(html).toContain('<a href="https://example.org" data-external="true">site</a>');
  });

  it("escapes HTML so documents cannot inject markup", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> and [x](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
  });
});
