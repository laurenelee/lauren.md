/**
 * Content negotiation at the edge.
 *
 * One Markdown file is the source of truth. Browsers get it rendered as HTML;
 * everything else gets the Markdown. Detection is by Accept header only —
 * never by User-Agent.
 *
 * `Vary: Accept` is mandatory on every negotiated response: without it the CDN
 * caches one audience's body and serves it to the other.
 */

const MARKDOWN = "text/markdown; charset=utf-8";
const HTML = "text/html; charset=utf-8";
const CACHE = "public, max-age=3600";

/** Paths that are always Markdown, whatever the client asks for. */
const ALWAYS_MARKDOWN = new Set(["/index.md", "/llms.txt"]);

/**
 * An explicit request for Markdown wins even when text/html is also listed;
 * otherwise text/html means a browser, and anything else — a wildcard Accept,
 * text/plain, a missing header — means an agent.
 */
function wantsMarkdown(accept) {
  const value = (accept || "").toLowerCase();
  if (value.includes("text/markdown")) return true;
  return !value.includes("text/html");
}

async function negotiated(env, request, asset, contentType) {
  // Forward validators so a revalidating client still gets a 304. The ETag we
  // hand back came from this asset, so it is the right one to compare against.
  const headers = new Headers();
  for (const name of ["If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await env.ASSETS.fetch(
    new Request(new URL(asset, request.url), { headers, method: request.method }),
  );
  const response = new Response(upstream.body, upstream);
  response.headers.set("Content-Type", contentType);
  response.headers.set("Cache-Control", CACHE);
  response.headers.set("Vary", "Accept");
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Static files the Worker has no opinion about. Checked first so that
    // ?format=md cannot corrupt a stylesheet or script request.
    if (path === "/style.css" || path.startsWith("/assets/")) {
      return env.ASSETS.fetch(request);
    }

    if (ALWAYS_MARKDOWN.has(path) || url.searchParams.get("format") === "md") {
      return negotiated(env, request, "/index.md", MARKDOWN);
    }

    if (path === "/") {
      return wantsMarkdown(request.headers.get("Accept"))
        ? negotiated(env, request, "/index.md", MARKDOWN)
        : negotiated(env, request, "/index.html", HTML);
    }

    // Single-page site: everything else is a wrong turn, so send it home.
    return Response.redirect(new URL("/", url).toString(), 302);
  },
};
