import domino from "@mixmark-io/domino";

// Parse server HTML without executing scripts, loading assets, or making requests.
export function documentFromHtml(html) {
  const doc = domino.createDocument(html);
  doc
    .querySelectorAll(
      'script,style,noscript,template,form,input,button,textarea,[hidden],[aria-hidden="true"]',
    )
    .forEach((n) => n.remove());
  doc.querySelectorAll("[style]").forEach((n) => {
    if (
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
        n.getAttribute("style"),
      )
    )
      n.remove();
  });
  return doc;
}
const blocks = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "TABLE",
  "TR",
  "SECTION",
  "HEADER",
  "FOOTER",
  "BLOCKQUOTE",
  "HR",
]);
export function htmlText(node) {
  const pre = [];
  function walk(n) {
    if (n.nodeType === 3) return n.textContent.replace(/\s+/g, " ");
    if (n.nodeType !== 1) return "";
    if (n.tagName === "PRE") {
      const index = pre.push(n.textContent) - 1;
      return "\n" + "\u0000PRE" + index + "\u0000" + "\n";
    }
    if (n.tagName === "BR") return "\n";
    const value = Array.from(n.childNodes).map(walk).join("");
    if (n.tagName === "TD" || n.tagName === "TH") return value.trim() + "\t";
    return blocks.has(n.tagName) ? "\n" + value.trim() + "\n" : value;
  }
  return walk(node)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000PRE(\d+)\u0000/g, (_, index) => pre[Number(index)]);
}
export function htmlSnapshot(html) {
  const doc = documentFromHtml(html);
  return {
    text: htmlText(doc.body),
    links: Array.from(doc.querySelectorAll("a[href]")).map((n) => ({
      text: n.textContent,
      href: n.getAttribute("href"),
    })),
  };
}
