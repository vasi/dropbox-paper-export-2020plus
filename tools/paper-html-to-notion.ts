import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";
import { Command } from "commander";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";

const HIGHLIGHT_COLORS: Record<string, string> = {
  "#D8C3FF": "purple",
  "#D6E8FA": "blue",
  "#B5DCAF": "green",
  "#F7CC62": "yellow",
  "#FFBFB5": "red",
};

function getIndentLevel(classes: string): number {
  const m = classes.match(/listindent(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

function convertInline($: CheerioAPI, nodes: AnyNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.data ?? "";
    } else if (node.type === "tag") {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      const children = $(el).contents().toArray();

      if (tag === "b") {
        out += `**${convertInline($, children)}**`;
      } else if (tag === "i") {
        out += `*${convertInline($, children)}*`;
      } else if (tag === "s") {
        out += `~~${convertInline($, children)}~~`;
      } else if (tag === "a") {
        const href = $(el).attr("href") ?? "";
        out += `[${convertInline($, children)}](${href})`;
      } else if (tag === "span") {
        const style = $(el).attr("style") ?? "";
        const highlightColor = $(el).attr("data-highlight-color");
        if (highlightColor) {
          const colorName = HIGHLIGHT_COLORS[highlightColor.toUpperCase()] ??
            HIGHLIGHT_COLORS[highlightColor] ??
            "yellow";
          out += `<span color="${colorName}_bg">${convertInline($, children)}</span>`;
        } else if (style.includes("font-family: monospace")) {
          out += `\`${$(el).text()}\``;
        } else {
          out += convertInline($, children);
        }
      } else if (tag === "img") {
        const emojiCh = $(el).attr("data-emoji-ch");
        if (emojiCh) {
          out += emojiCh;
        } else {
          const src = $(el).attr("src") ?? "";
          out += `![](${src})`;
        }
      } else {
        out += convertInline($, children);
      }
    }
  }
  return out;
}

function convertCell($: CheerioAPI, td: Element): string {
  const aceLine = $(td).find("div.ace-line").first();
  if (!aceLine.length) return "";
  return convertInline($, aceLine.contents().toArray());
}

function convertTable($: CheerioAPI, table: Element): string {
  const hasHeader = $(table).hasClass("table-top-header");
  const rows = $(table).find("tr").toArray();

  const htmlRows = rows.map((tr) => {
    const cells = $(tr).find("td").toArray();
    const cellContents = cells.map((td) => convertCell($, td as Element));
    return `<tr>${cellContents.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  });

  const attr = hasHeader ? ` header-row="true"` : "";
  return `<table${attr}>\n${htmlRows.join("\n")}\n</table>`;
}

function flushCodeBuffer(codeBuffer: string[]): string {
  const result = "```\n" + codeBuffer.join("\n") + "\n```";
  codeBuffer.length = 0;
  return result;
}

function convertBody($: CheerioAPI, aceLines: Element[]): string {
  const output: string[] = [];
  const codeBuffer: string[] = [];

  function pushLine(line: string) {
    if (codeBuffer.length > 0) {
      output.push(flushCodeBuffer(codeBuffer));
    }
    output.push(line);
  }

  for (const div of aceLines) {
    const $div = $(div);

    // h1
    const h1 = $div.children("h1").first();
    if (h1.length) {
      pushLine(`# ${convertInline($, h1.contents().toArray())}`);
      continue;
    }

    // h2
    const h2 = $div.children("h2").first();
    if (h2.length) {
      pushLine(`## ${convertInline($, h2.contents().toArray())}`);
      continue;
    }

    // h3 — ace-all-bold-hthree wraps content in <b>; pass <b>'s children to avoid **
    const h3span = $div.children("span.ace-all-bold-hthree").first();
    if (h3span.length) {
      const bEl = h3span.find("b").first();
      const content = bEl.length
        ? convertInline($, bEl.contents().toArray())
        : convertInline($, h3span.contents().toArray());
      pushLine(`### ${content}`);
      continue;
    }

    // section break
    if ($div.find("hr").length) {
      pushLine("---");
      continue;
    }

    // table
    const table = $div.find("table").first();
    if (table.length) {
      pushLine(convertTable($, table[0] as Element));
      continue;
    }

    // code line — accumulate
    const code = $div.children("code").first();
    if (code.length) {
      codeBuffer.push(convertInline($, code.contents().toArray()));
      continue;
    }

    // lists
    const ul = $div.children("ul, ol").first();
    if (ul.length) {
      const ulEl = ul[0] as Element;
      const classes = $(ulEl).attr("class") ?? "";
      const indent = getIndentLevel(classes);
      const prefix = "\t".repeat(indent - 1);
      const li = ul.children("li").first();
      // strip <input> checkbox and the &nbsp; text node Paper inserts after it
      const liNodes = li.contents().toArray().filter(
        (n) => !(n.type === "tag" && (n as Element).tagName === "input"),
      );
      const textStart = liNodes.findIndex(
        (n) => !(n.type === "text" && (n as Text).data === " "),
      );
      const contentNodes = textStart >= 0 ? liNodes.slice(textStart) : liNodes;
      const inline = convertInline($, contentNodes);

      if (classes.includes("listtype-indent")) {
        // multi-line continuation: append to last output line
        if (output.length > 0) {
          output[output.length - 1] += `<br>${inline}`;
        } else {
          pushLine(inline);
        }
        continue;
      }

      let marker: string;
      if (classes.includes("listtype-bullet")) {
        marker = "- ";
      } else if (classes.includes("listtype-number")) {
        marker = "1. ";
      } else if (classes.includes("listtype-taskdone")) {
        marker = "- [x] ";
      } else if (classes.includes("listtype-task")) {
        marker = "- [ ] ";
      } else {
        marker = "- ";
      }

      pushLine(`${prefix}${marker}${inline}`);
      continue;
    }

    // paragraph (or blank if convertInline yields nothing)
    const inline = convertInline($, $div.contents().toArray());
    if (inline.trim() === "") {
      pushLine("");
    } else {
      pushLine(inline);
    }
  }

  // flush any trailing code block
  if (codeBuffer.length > 0) {
    output.push(flushCodeBuffer(codeBuffer));
  }

  return output.join("\n");
}

function convert(html: string): { title: string; markdown: string } {
  const $ = load(html);

  const allAceLines = $("body").children("div.ace-line").toArray() as Element[];

  // title: first ace-line with font-size: 40px
  let titleEl: Element | null = null;
  for (const el of allAceLines) {
    const style = $(el).attr("style") ?? "";
    if (style.includes("font-size: 40px")) {
      titleEl = el;
      break;
    }
  }

  const title = titleEl ? $(titleEl).text().trim() : "Untitled";
  const bodyLines = titleEl
    ? allAceLines.filter((el) => el !== titleEl)
    : allAceLines;

  const markdown = convertBody($, bodyLines);
  return { title, markdown };
}

function upload(title: string, markdown: string, parentId?: string) {
  const body: Record<string, unknown> = {
    parent: parentId ? { page_id: parentId } : { workspace: true },
    properties: {
      title: { title: [{ text: { content: title } }] },
    },
    markdown,
  };

  const result = spawnSync("ntn", ["api", "v1/pages"], {
    input: JSON.stringify(body),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (result.error) {
    console.error("Failed to run ntn:", result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.exit(result.status ?? 1);
  }

  const response = JSON.parse(result.stdout) as { url?: string };
  console.log(response.url ?? "(no url in response)");
}

const program = new Command();
program
  .argument("<file>", "Path to Dropbox Paper HTML export")
  .option("--parent-id <id>", "Notion page ID to create the page under")
  .option("--dry-run", "Print markdown to stdout instead of uploading")
  .action((file: string, opts: { parentId?: string; dryRun?: boolean }) => {
    const html = readFileSync(file, "utf8");
    const { title, markdown } = convert(html);
    if (opts.dryRun) {
      console.log(`=== Title: ${title} ===\n`);
      console.log(markdown);
    } else {
      upload(title, markdown, opts.parentId);
    }
  });

program.parse();
