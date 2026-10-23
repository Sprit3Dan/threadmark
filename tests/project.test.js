import { describe, it, expect } from "vitest";
import { projectInline, projectText } from "../src/core/project.js";

const P = (src) => projectInline(src, 0);

describe("projectInline", () => {
  it("passes plain prose through unchanged", () => {
    const p = P("hello world");
    expect(p.plain).toBe("hello world");
    expect(p.map).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("drops emphasis markers but keeps the text and its source positions", () => {
    const p = P("the **p95** latency");
    expect(p.plain).toBe("the p95 latency");
    // 'p' lives at source index 6, behind the two asterisks
    expect(p.map[4]).toBe(6);
    expect(p.toSource(4)).toBe(6);
    expect(p.toSource(7)).toBe(11); // just past "p95", before the closing **
  });

  it("renders a link's text and guards its destination", () => {
    const src = "see [the docs](https://x.test/y) now";
    const p = P(src);
    expect(p.plain).toBe("see the docs now");
    const destGuard = p.guarded.find(([s, e]) => src.slice(s, e).startsWith("]("));
    expect(destGuard).toBeTruthy();
    expect(src.slice(destGuard[0], destGuard[1])).toBe("](https://x.test/y)");
  });

  it("allows a span inside link text, and one spanning the whole link", () => {
    const src = "see [the docs](https://x.test/y) now";
    const p = P(src);
    const inside = p.adjust(8, 11); // "doc", entirely within the link text
    expect(inside.expanded).toBe(false);
    expect(src.slice(inside.start, inside.end)).toBe("doc");

    // A selection that reaches the link's edges puts the pair outside the link.
    const spanning = p.adjust(4, 13); // "the docs " over the whole link's text
    expect(spanning.expanded).toBe(false);
    expect(src.slice(spanning.start, spanning.end)).toBe("[the docs](https://x.test/y) ");
  });

  it("widens a selection that cuts into inline code to the whole code span", () => {
    const src = "run `npm install` first";
    const p = P(src);
    expect(p.plain).toBe("run npm install first");

    const inside = p.adjust(5, 8); // "pm " inside the code span
    expect(src.slice(inside.start, inside.end)).toBe("`npm install`");
    expect(inside.expanded).toBe(true);

    const halfIn = p.adjust(12, 21); // "ll first" starts inside the span
    expect(src.slice(halfIn.start, halfIn.end)).toBe("`npm install` first");

    const surrounding = p.adjust(0, 16); // "run npm install ", the whole span inside
    expect(surrounding.expanded).toBe(false);
    expect(src.slice(surrounding.start, surrounding.end)).toBe("run `npm install` ");
  });

  it("widens a selection inside an autolink to the whole autolink", () => {
    const src = "go <https://x.test/a>";
    const p = P(src);
    expect(p.plain).toBe("go https://x.test/a");
    const part = p.adjust(4, 10); // "https:" lives inside the autolink
    expect(src.slice(part.start, part.end)).toBe("<https://x.test/a>");
    const whole = p.adjust(0, 19);
    expect(whole.expanded).toBe(false);
    expect(src.slice(whole.start, whole.end)).toBe(src);
  });

  it("treats blockquote continuation markup as part of the line break", () => {
    const p = projectInline("first line\n> second line", 0, { quoted: true });
    expect(p.plain).toBe("first line second line");
    expect(p.toSource(11)).toBe(13);
  });

  it("decodes entities and escapes", () => {
    expect(projectText("a &amp; b")).toBe("a & b");
    expect(projectText("a \\* b")).toBe("a * b");
    expect(projectText("rock &amp; roll")).toBe("rock & roll");
  });

  it("treats a soft break as one space and trims the block end", () => {
    const p = P("line one\nline two   ");
    expect(p.plain).toBe("line one line two");
  });

  it("renders autolinks as their target", () => {
    expect(projectText("go <https://x.test/a>")).toBe("go https://x.test/a");
  });

  it("renders inline HTML as markup, contributing only its inner text", () => {
    expect(projectText("a <b>bold</b> word")).toBe("a bold word");
    expect(projectText("press <kbd>Esc</kbd><br> now")).toBe("press Esc now");
  });

  it("hides an inline HTML comment and guards it", () => {
    const p = P("before <!-- note --> after");
    expect(p.plain).toBe("before  after");
    expect(p.guarded).toContainEqual([7, 20]);
  });

  it("contributes no text for an image", () => {
    const p = P("before ![alt text](/i.png) after");
    expect(p.plain).toBe("before  after");
    expect(p.adjust(0, 18)).toBeTruthy();
  });

  it("handles nested markup without losing its head", () => {
    const p = P("a **bold *and italic* link** [x](y)");
    expect(p.plain).toBe("a bold and italic link x");
    const sel = p.adjust(7, 11); // "and "
    expect(p.plain.slice(sel.plainStart, sel.plainEnd)).toBe("and ");
  });

  it("maps source offsets back to plain offsets", () => {
    const p = P("the **p95** latency");
    expect(p.toPlain(6)).toBe(4);
    expect(p.toPlain(9)).toBe(7);
    expect(p.toPlain(11)).toBe(7);
  });
});
