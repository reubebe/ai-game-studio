/** Small, safe Markdown renderer: text is escaped first, so documents cannot inject HTML. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-external="true">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<span class=\"mono\">$1</span>");
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      closeList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else if (/^\|/.test(line)) {
      closeList();
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) rows.push(lines[i++]!);
      const cells = (r: string) => r.split("|").slice(1, -1).map((c) => c.trim());
      const body = rows.filter((r) => !/^\|\s*-/.test(r));
      out.push(`<table class="table">${body.map((r, n) => `<tr>${cells(r).map((c) => (n === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("")}</table>`);
      continue;
    } else {
      closeList();
      const para: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "" && !/^(#|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i + 1]!)) para.push(lines[++i]!);
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    i++;
  }
  closeList();
  return out.join("\n");
}
