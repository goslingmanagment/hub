import { createElement, Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type MdAlign, type MdBlock, type MdInline } from "../markdown.js";
import { cx } from "./cx.js";

/**
 * A page an agent wrote, in the app's own type: headings, paragraphs, lists,
 * tables, quotes, code and links (markdown.ts reads the text). Nothing in it
 * runs and nothing is loaded: a tag is shown as text, an image as a link to
 * it. Money, dates and periods stay exactly as the author wrote them. A wide
 * table scrolls inside its own frame, never the page.
 *
 * Styles: styles/markdown.css (in styles.css for Workboard; the console
 * imports the file beside its screen). They read the shared `--ui-*` tokens
 * and fall back to the console's `--color-*`.
 */
export function Markdown({ source, headingLevel = 2, className }: {
  source: string;
  /** The tag a `#` heading gets: under a screen's own h1 that is h2, under a card's title h3. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={cx("ui-md", className)}>{renderBlocks(blocks, headingLevel, false)}</div>;
}

function renderBlocks(blocks: readonly MdBlock[], headingLevel: number, tight: boolean): ReactNode {
  return blocks.map((block, index) => <Fragment key={index}>{renderBlock(block, headingLevel, tight)}</Fragment>);
}

const ALIGN_CLASS: Readonly<Record<Exclude<MdAlign, null>, string>> = {
  left: "ui-md__left",
  center: "ui-md__center",
  right: "ui-md__right",
};

/** A cell this short stays on one line; a longer one wraps, never narrower than a short phrase. */
const SHORT_CELL = 20;

function plainLength(nodes: readonly MdInline[]): number {
  return nodes.reduce((sum, node) => sum + ("text" in node ? node.text.length : "children" in node ? plainLength(node.children) : 0), 0);
}

function cell(align: MdAlign, inline: readonly MdInline[]): string | undefined {
  const classes = [align === null ? null : ALIGN_CLASS[align], plainLength(inline) <= SHORT_CELL ? "ui-md__short" : "ui-md__long"];
  return classes.filter(Boolean).join(" ");
}

function renderBlock(block: MdBlock, headingLevel: number, tight: boolean): ReactNode {
  switch (block.kind) {
    case "heading": {
      const tag = `h${Math.min(6, headingLevel + block.level - 1)}`;
      return createElement(tag, { className: `ui-md__h${block.level}` }, renderInline(block.inline));
    }
    case "paragraph":
      // A tight list's item is its text, without a paragraph's space.
      return tight ? renderInline(block.inline) : <p>{renderInline(block.inline)}</p>;
    case "list": {
      const items = block.items.map((item, index) => <li key={index}>{renderBlocks(item, headingLevel, block.tight)}</li>);
      return block.ordered
        ? <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
        : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div className="ui-md__table">
          <table>
            <thead>
              <tr>{block.head.map((inline, index) => <th key={index} scope="col" className={cell(block.align[index] ?? null, inline)}>{renderInline(inline)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((inline, index) => <td key={index} className={cell(block.align[index] ?? null, inline)}>{renderInline(inline)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return <pre><code>{block.text}</code></pre>;
    case "quote":
      return <blockquote>{renderBlocks(block.blocks, headingLevel, false)}</blockquote>;
    case "rule":
      return <hr />;
  }
}

/** Digits joined by a separator (`2026-07-04`, `02.11–08.11`, `25.01`, `38/60`, `06:25`). */
const NUMBER_TOKEN = /(\d+(?:[.,:/\u2013-]\d+)+)/;

/** The text as written, a date or a range kept on one line (the browser breaks after a hyphen). */
function renderText(text: string): ReactNode {
  if (!NUMBER_TOKEN.test(text)) return text;
  return text.split(NUMBER_TOKEN).map((part, index) => (index % 2 === 1 ? <span key={index} className="ui-md__num">{part}</span> : part));
}

function renderInline(nodes: readonly MdInline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{renderText(node.text)}</Fragment>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children)}</del>;
      case "break":
        return <br key={index} />;
      case "link": {
        // Away from the app: a new tab that cannot reach back into this one.
        const away = !node.href.startsWith("/") && !node.href.startsWith("#");
        return (
          <a key={index} href={node.href} {...(away ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {renderInline(node.children)}
          </a>
        );
      }
    }
  });
}
