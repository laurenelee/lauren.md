#!/usr/bin/env node
/**
 * build.js — renders public/index.md to public/index.html.
 *
 * index.md is the source of truth. This script:
 *   1. stamps the "last updated" block in index.md (in place, idempotent),
 *   2. pulls the <meta name="description"> from the first blockquote line,
 *   3. renders the Markdown with `marked`,
 *   4. wraps it in the particle-reveal DOM structure and writes index.html.
 *
 * Determinism: the only non-constant input is the date. Set SOURCE_DATE_EPOCH
 * to pin it; otherwise it is today's date in UTC, so repeated runs on the same
 * day are byte-identical.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { gfmHeadingId } from "marked-gfm-heading-id";

const root = dirname(fileURLToPath(import.meta.url));
const MD_PATH = join(root, "public", "index.md");
const HTML_PATH = join(root, "public", "index.html");
const CSS_PATH = join(root, "public", "style.css");

const SITE = "https://lauren.md";
const FALLBACK_TITLE = "Lauren Lee";

/**
 * The page background. The shader uses this to tell UI pixels apart from empty
 * backdrop, so it MUST equal the background painted by style.css — see the
 * assertion in checkBackgroundMatchesStylesheet().
 */
const BACKGROUND = "#f2e9d7";

/** Exact option values for the vendored Canvas UI particle-reveal effect. */
const PARTICLE_OPTIONS = {
  radius: 750,
  softness: 0.5,
  size: 0.75,
  scatter: 50,
  drift: 0.5,
  aberration: 50,
  bend: 50,
  fade: 0.85,
  threshold: 0.1,
  smoothing: 0.25,
  background: BACKGROUND,
};

const STAMP_START = "<!-- last-modified:start -->";
const STAMP_END = "<!-- last-modified:end -->";

/** Build date as YYYY-MM-DD (UTC), overridable for reproducible builds. */
function buildDate() {
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw !== undefined && raw !== "") {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) {
      throw new Error(`SOURCE_DATE_EPOCH is not a number: ${raw}`);
    }
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Rewrite the block between the stamp markers. Agents read the raw Markdown,
 * so the date has to live in index.md itself, not only in the HTML render.
 */
function stampLastModified(markdown, date) {
  const start = markdown.indexOf(STAMP_START);
  const end = markdown.indexOf(STAMP_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `public/index.md is missing its ${STAMP_START} / ${STAMP_END} markers; ` +
        "the last-updated line is generated and cannot be stamped without them.",
    );
  }
  const line = `*Last updated: ${date} · Canonical Markdown: <${SITE}/index.md>*`;
  return (
    markdown.slice(0, start) + `${STAMP_START}\n${line}\n` + markdown.slice(end)
  );
}

/** First blockquote line, comments and markup stripped, for the meta tag. */
function extractDescription(markdown) {
  const match = markdown.match(/^>[ \t]?(.*)$/m);
  if (!match) {
    throw new Error(
      "public/index.md has no blockquote; the page description is sourced " +
        "from the first blockquote line.",
    );
  }
  const text = match[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    throw new Error(
      "The first blockquote in public/index.md is empty once comments are " +
        "stripped; it is used as the page description.",
    );
  }
  return text;
}

/** First ATX h1, used as <title>. */
function extractTitle(markdown) {
  const match = markdown.match(/^#[ \t]+(.+?)[ \t]*#*$/m);
  return match ? match[1].trim() : FALLBACK_TITLE;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Guards acceptance criterion 10: the effect's `background` option and the
 * page background must be the identical value, or the shader misreads which
 * pixels are content.
 */
function checkBackgroundMatchesStylesheet() {
  const css = readFileSync(CSS_PATH, "utf8");
  if (!css.includes(BACKGROUND)) {
    throw new Error(
      `public/style.css does not mention "${BACKGROUND}". The page background ` +
        "and the particle-reveal `background` option must be identical.",
    );
  }
}

function renderPage({ title, description, content }) {
  // Rendered as a JS object literal, indented to sit inside the module below.
  const options = [
    "{",
    ...Object.entries(PARTICLE_OPTIONS).map(
      ([key, value]) => `            ${key}: ${JSON.stringify(value)},`,
    ),
    "          }",
  ].join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${SITE}/" />
    <link rel="alternate" type="text/markdown" href="/index.md" />
    <meta name="theme-color" content="#f2e9d7" />
    <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,500..700,100&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=IBM+Plex+Mono:wght@400;500&display=swap" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <!--
      The rendered Markdown below is real DOM and is served in the HTML body.
      The canvases are inert until the inline module at the end of this file
      confirms html-in-canvas support; without JavaScript, or on an engine
      that lacks the API, this is simply a styled document.
    -->
    <div class="stage" id="stage">
      <canvas class="stage-source" id="stage-source" layoutsubtree="true"></canvas>
      <div class="stage-content" id="stage-content">
        <main class="doc">
${content.trimEnd()}
        </main>
      </div>
      <canvas class="stage-output" id="stage-output" aria-hidden="true"></canvas>
    </div>

    <script type="module">
      import {
        createParticleReveal,
        supportsHtmlInCanvas,
      } from "/assets/particle-reveal.js";

      // Progressive enhancement: bail out and leave the plain document alone
      // unless the experimental html-in-canvas API is actually present.
      if (supportsHtmlInCanvas()) {
        const stage = document.getElementById("stage");
        const source = document.getElementById("stage-source");
        const content = document.getElementById("stage-content");
        const output = document.getElementById("stage-output");

        // Move the live content into the layoutsubtree canvas so it can be
        // captured. It stays in the DOM, so it stays available to assistive
        // technology and to anything reading the page.
        source.appendChild(content);
        stage.classList.add("is-active");

        // The captured subtree is out of the stage's flow, so the stage would
        // otherwise collapse to zero height and the canvases with it. Mirror
        // the content's height onto the stage so they cover the whole document
        // and the page keeps scrolling natively.
        const syncHeight = () => {
          const height = content.scrollHeight;
          if (height > 0 && stage.style.height !== height + "px") {
            stage.style.height = height + "px";
            return true;
          }
          return false;
        };
        syncHeight();

        const instance = createParticleReveal(
          { source, content, output },
          ${options},
        );

        if (instance) {
          // Reflow (viewport width, late-loading fonts) changes the content
          // height; keep the stage and the canvases in step with it.
          new ResizeObserver(() => {
            if (syncHeight()) instance.resize();
          }).observe(content);
        } else {
          // createParticleReveal returns null if WebGL2 is unavailable. Put the
          // document back exactly as it was rather than leave an empty canvas.
          stage.classList.remove("is-active");
          stage.style.height = "";
          stage.insertBefore(content, output);
        }
      }
    </script>
  </body>
</html>
`;
}

function main() {
  checkBackgroundMatchesStylesheet();
  marked.use(gfmHeadingId());

  const original = readFileSync(MD_PATH, "utf8");
  const markdown = stampLastModified(original, buildDate());
  if (markdown !== original) {
    writeFileSync(MD_PATH, markdown);
  }

  const html = renderPage({
    title: extractTitle(markdown),
    description: extractDescription(markdown),
    content: marked.parse(markdown, { gfm: true, async: false }),
  });
  writeFileSync(HTML_PATH, html);

  console.log(
    `built public/index.html (${html.length} bytes) from public/index.md`,
  );
}

main();
