import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Se ejecuta con Node después de next build: prepara la copia estática de la
// raíz para Live Server, que por sí solo no compila la aplicación.
const root = process.cwd();
const output = join(root, "out");
const rootAssets = join(root, "_next");
const blockTags = new Set([
  "html",
  "head",
  "body",
  "main",
  "div",
  "header",
  "section",
  "figure",
  "figcaption",
  "aside",
  "nav",
  "footer",
  "p",
  "fieldset",
  "legend",
  "label",
  "link",
  "meta",
  "script",
  "style",
]);
const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function findTagEnd(html, start) {
  let quote = "";

  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }

  return html.length;
}

function formatHtml(html) {
  let result = "";
  const elements = [];
  let offset = 0;
  let rawTag = "";

  // Los comentarios separan bloques sin introducir nodos de texto adicionales
  // que puedan alterar la hidratación de React.
  const separator = () => {
    result += `<!--\n${"  ".repeat(elements.length)}-->`;
  };

  while (offset < html.length) {
    if (rawTag) {
      const closingStart = html.toLowerCase().indexOf(`</${rawTag}`, offset);
      if (closingStart === -1) {
        result += html.slice(offset);
        break;
      }

      result += html.slice(offset, closingStart);
      offset = closingStart;
      rawTag = "";
      continue;
    }

    const tagStart = html.indexOf("<", offset);
    if (tagStart === -1) {
      result += html.slice(offset);
      break;
    }

    const text = html.slice(offset, tagStart);
    result += text;
    offset = tagStart;

    if (html.startsWith("<!--", offset)) {
      const commentEnd = html.indexOf("-->", offset + 4);
      const end = commentEnd === -1 ? html.length : commentEnd + 3;
      result += html.slice(offset, end);
      offset = end;
      continue;
    }

    if (html.startsWith("<!", offset) || html.startsWith("<?", offset)) {
      const declarationEnd = findTagEnd(html, offset);
      result += html.slice(offset, declarationEnd);
      offset = declarationEnd;
      continue;
    }

    const tagEnd = findTagEnd(html, offset);
    const tag = html.slice(offset, tagEnd);
    const match = tag.match(/^<\s*(\/?)\s*([^\s/>]+)/);
    if (!match) {
      result += tag;
      offset = tagEnd;
      continue;
    }

    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const selfClosing = /\/\s*>$/.test(tag) || voidTags.has(name);

    if (closing) elements.pop();
    if (!closing && blockTags.has(name)) separator();
    result += tag;
    if (!closing && !selfClosing) {
      elements.push(name);
      if (name === "script" || name === "style") rawTag = name;
    }

    offset = tagEnd;
  }

  return `${result.trim()}\n`;
}

const html = await readFile(join(output, "index.html"), "utf8");
await rm(rootAssets, { recursive: true, force: true });
await cp(join(output, "_next"), rootAssets, { recursive: true });
await writeFile(join(root, "index.html"), formatHtml(html), "utf8");
