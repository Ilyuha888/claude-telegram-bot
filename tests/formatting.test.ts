/**
 * Tests for src/formatting.ts — Markdown to Telegram HTML conversion.
 *
 * Run with: bun test tests/formatting.test.ts
 *
 * Focus is on the emphasis rules, code-fence language preservation, and the
 * placeholder/stash mechanism that protects code content from the inline
 * regex passes.
 */

import { describe, it, expect } from "bun:test";
import { convertMarkdownToHtml, escapeHtml } from "../src/formatting";

describe("escapeHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;"
    );
  });
});

describe("emphasis", () => {
  it("converts **text** to bold", () => {
    expect(convertMarkdownToHtml("**bold**")).toBe("<b>bold</b>");
  });

  it("converts *text* to italic, not bold", () => {
    expect(convertMarkdownToHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("converts _text_ to italic", () => {
    expect(convertMarkdownToHtml("_italic_")).toBe("<i>italic</i>");
  });

  it("keeps bold and italic distinct in the same string", () => {
    expect(convertMarkdownToHtml("**bo** and *it*")).toBe(
      "<b>bo</b> and <i>it</i>"
    );
  });

  it("does not let the italic pass mangle adjacent bold", () => {
    // The bold pass must run first and consume both asterisk pairs.
    const out = convertMarkdownToHtml("**a** *b* **c**");
    expect(out).toBe("<b>a</b> <i>b</i> <b>c</b>");
  });
});

describe("code fences", () => {
  it("preserves the language as a nested code tag", () => {
    expect(convertMarkdownToHtml("```python\nprint(1)\n```")).toBe(
      '<pre><code class="language-python">print(1)\n</code></pre>'
    );
  });

  it("falls back to a bare pre tag when no language is given", () => {
    // Telegram only accepts a language via a nested <code> tag; a standalone
    // <pre> must not carry a language class.
    expect(convertMarkdownToHtml("```\nplain\n```")).toBe(
      "<pre>plain\n</pre>"
    );
  });

  it("escapes HTML inside code blocks", () => {
    expect(convertMarkdownToHtml("```html\n<div>&</div>\n```")).toBe(
      '<pre><code class="language-html">&lt;div&gt;&amp;&lt;/div&gt;\n</code></pre>'
    );
  });

  it("does not apply markdown emphasis inside code blocks", () => {
    const out = convertMarkdownToHtml("```js\nlet a = b * c * d;\n```");
    expect(out).toContain("b * c * d");
    expect(out).not.toContain("<i>");
  });
});

describe("inline code", () => {
  it("wraps inline code and escapes it", () => {
    expect(convertMarkdownToHtml("use `a < b` here")).toBe(
      "use <code>a &lt; b</code> here"
    );
  });
});

describe("$-sequences are not treated as replacement patterns", () => {
  // String.prototype.replace(string, string) interprets $$, $&, $` and $' in
  // the REPLACEMENT as special patterns. Restoring stashed code with a plain
  // string therefore corrupted any code containing them; the restore uses a
  // replacer function instead. These cases pin that behaviour.

  it("preserves $$ in a code block (shell PID / Makefile escape)", () => {
    expect(convertMarkdownToHtml("```bash\necho $$\n```")).toBe(
      '<pre><code class="language-bash">echo $$\n</code></pre>'
    );
  });

  it("preserves $$ in inline code", () => {
    expect(convertMarkdownToHtml("run `echo $$`")).toBe(
      "run <code>echo $$</code>"
    );
  });

  it("preserves $& without leaking the internal placeholder", () => {
    const out = convertMarkdownToHtml("```bash\necho $&\n```");
    expect(out).toBe(
      '<pre><code class="language-bash">echo $&amp;\n</code></pre>'
    );
    expect(out).not.toContain("CODEBLOCK");
  });

  it("preserves $' in a code block", () => {
    expect(convertMarkdownToHtml("```bash\nprintf $'a-b'\n```")).toBe(
      "<pre><code class=\"language-bash\">printf $'a-b'\n</code></pre>"
    );
  });

  it("never leaks a stash placeholder into the output", () => {
    const nasty = "```bash\necho $$ $& $` $'\n```\nand `$& inline`";
    const out = convertMarkdownToHtml(nasty);
    expect(out).not.toContain("CODEBLOCK");
    expect(out).not.toContain("INLINECODE");
    expect(out).not.toContain("\x00");
  });
});

describe("other constructs", () => {
  it("converts headers to bold", () => {
    expect(convertMarkdownToHtml("# Title")).toContain("<b>Title</b>");
  });

  it("converts bullet markers to a bullet character", () => {
    expect(convertMarkdownToHtml("- one")).toContain("• one");
  });

  it("converts links", () => {
    expect(convertMarkdownToHtml("[t](https://e.com)")).toBe(
      '<a href="https://e.com">t</a>'
    );
  });

  it("collapses runs of blank lines", () => {
    expect(convertMarkdownToHtml("a\n\n\n\nb")).toBe("a\n\nb");
  });
});
