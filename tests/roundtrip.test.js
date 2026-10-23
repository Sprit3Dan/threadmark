import { describe, it, expect } from "vitest";
import { analyze, projection } from "../src/core/doc.js";
import { stripMarkers, insertMarkers, findMarkers, markerText } from "../src/core/markers.js";
import { resolveMarkers, quoteBetween, isBlocked } from "../src/core/annotate.js";

const DOC = `# Latency results

The p95 **latency is 40ms** and we measured it twice, see [the run](https://x.test/r).

| region | p95 | note |
| --- | --- | --- |
| eu | 40ms | warm cache |
| us | 90ms | cold start |

- [x] measure the eu path
- [ ] measure the us path

\`\`\`js
const p95 = 40; // this must not be annotatable
\`\`\`

Trailing paragraph with an &amp; entity and a soft
break in the middle.
`;

function unitBySnippet(analysis, snippet) {
  for (const u of analysis.units.values()) {
    if (projection(u).plain.includes(snippet)) return u;
  }
  throw new Error("no unit containing " + snippet);
}

describe("analyze", () => {
  it("finds every annotatable unit with its verbatim source slice", () => {
    const a = analyze(DOC);
    const unitList = [...a.units.values()].filter((u) => !u.unmappable);
    expect(unitList.length).toBeGreaterThan(6);
    for (const u of unitList) {
      expect(DOC.slice(u.srcStart, u.srcStart + u.srcLen)).toBe(u.content);
      expect(projection(u).plain.length).toBeGreaterThan(0);
    }
    const checkbox = unitList.find((u) => u.checkbox);
    expect(checkbox.checkbox).toBe("checked");
    expect(checkbox.src.length).toBeGreaterThan(0);
  });

  it("records fenced code as a blocked range", () => {
    const a = analyze(DOC);
    const codeAt = DOC.indexOf("const p95 = 40;");
    expect(isBlocked(a, codeAt)).toBe(true);
    expect(isBlocked(a, DOC.indexOf("Trailing paragraph"))).toBe(false);
  });

  it("lists headings for the in: context line", () => {
    const a = analyze(DOC);
    expect(a.headings.map((h) => h.text)).toContain("Latency results");
  });

  it("drops the checkbox prefix from a task item's text", () => {
    const a = analyze(DOC);
    const u = unitBySnippet(a, "measure the eu path");
    expect(u.checkbox).toBe("checked");
    expect(projection(u).plain).toBe("measure the eu path");
  });
});

describe("selection -> markers -> selection", () => {
  function roundTrip(snippet, doc = DOC) {
    const a = analyze(doc);
    const u = unitBySnippet(a, snippet);
    const proj = projection(u);
    const plainStart = proj.plain.indexOf(snippet);
    expect(plainStart, snippet + " not found in " + proj.plain).toBeGreaterThanOrEqual(0);
    const adj = proj.adjust(plainStart, plainStart + snippet.length);
    expect(adj, "adjust refused " + snippet).not.toBe(null);

    const saved = insertMarkers(doc, [{ id: 7, start: adj.start, end: adj.end }]);
    expect(saved.length).toBe(doc.length + markerText(7, "start").length + markerText(7, "end").length);

    const { clean, markers } = stripMarkers(saved);
    expect(clean).toBe(doc); // removing what we inserted gives the file back exactly

    const mine = markers.filter((m) => m.id === 7);
    expect(mine.map((m) => m.side)).toEqual(["start", "end"]);
    expect(mine[0].cleanIndex).toBe(adj.start);
    expect(mine[1].cleanIndex).toBe(adj.end);

    const again = analyze(clean);
    const spans = resolveMarkers(again, markers);
    const span = spans.find((s) => s.id === 7);
    expect(span.ok, span.reason).toBe(true);
    expect(quoteBetween(again, span.srcStart, span.srcEnd)).toBe(snippet);
    return { a, u, proj, adj, saved, span };
  }

  it("round-trips a span crossing bold text", () => roundTrip("latency is 40ms"));
  it("round-trips a span in a table cell", () => roundTrip("warm cache"));
  it("round-trips a table header cell", () => roundTrip("region"));
  it("round-trips a task list item", () => roundTrip("measure the eu path"));
  it("round-trips a decoded entity", () => roundTrip("entity and a soft"));
  it("round-trips across a soft line break", () => roundTrip("break in the middle"));

  it("puts the pair outside a link whose whole text is selected", () => {
    const { saved } = roundTrip("the run");
    expect(saved).toContain("<!-- @t7:start -->[the run](https://x.test/r)<!-- @t7:end -->");
  });

  it("keeps a span inside a link's text when it doesn't reach the edges", () => {
    const { saved } = roundTrip("he ru");
    expect(saved).toContain("[t<!-- @t7:start -->he ru<!-- @t7:end -->n]");
  });

  it("flags a lone marker as an incomplete pair instead of hiding it", () => {
    const broken = DOC.replace("Trailing paragraph", "<!-- @t9:start -->Trailing paragraph");
    const { clean, markers } = stripMarkers(broken);
    const spans = resolveMarkers(analyze(clean), markers);
    expect(spans.find((s) => s.id === 9)).toMatchObject({ ok: false, reason: "incomplete pair" });
  });

  it("keeps a thread whose flagged words an agent deleted", () => {
    const emptied = DOC.replace("Trailing paragraph", "<!-- @t3:start --><!-- @t3:end -->");
    const { clean, markers } = stripMarkers(emptied);
    const span = resolveMarkers(analyze(clean), markers).find((s) => s.id === 3);
    expect(span).toBeTruthy();
    expect(span.quote).toBe(""); // nothing between the markers any more
  });
});
