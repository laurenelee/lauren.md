# lauren.md

A personal site whose primary audience is machines.

One Markdown file — [`public/index.md`](public/index.md) — is the single source
of truth, in the spirit of the `AGENTS.md` convention. A Cloudflare Worker
negotiates at the edge:

- **Browsers** (`Accept: text/html`) get the Markdown rendered as a styled HTML
  document, wrapped in a WebGL "particle reveal" effect.
- **Everything else** — agents, `curl`, `fetch`, scripts — gets the raw
  Markdown, with `Content-Type: text/markdown; charset=utf-8`.

Detection is by `Accept` header only. There is no User-Agent sniffing anywhere
in this repository, and there is no backend beyond the Worker.

---

## Requirements

- **Node** 20+ (CI uses 22)
- **pnpm** — the version is pinned by the `packageManager` field in
  `package.json`. Install it with Corepack:
  ```bash
  corepack enable
  corepack prepare --activate
  ```
- **Socket Firewall (`sfw`)** — Socket's install-time firewall, which sits in
  front of the package manager and blocks malicious dependencies before they
  land ([SocketDev/sfw-free](https://github.com/SocketDev/sfw-free)):
  ```bash
  pnpm add -g sfw
  ```

### Command policy

`sfw` wraps **every command that downloads or executes new package code**:

| Prefix with `sfw` | Run bare |
| --- | --- |
| `sfw pnpm install` | `pnpm build` |
| `sfw pnpm add <pkg>` | `pnpm run <script>` |
| `sfw pnpm update` | `pnpm dev` / `wrangler dev` |
| `sfw pnpm dlx <pkg>` | `wrangler deploy` |

This applies in CI too — see [`.github/workflows/`](.github/workflows). The one
unavoidable exception is `pnpm add -g sfw` itself: the wrapper cannot wrap its
own installation.

No `npm` or `yarn` command appears anywhere in this repository.

---

## Local development

```bash
sfw pnpm install
pnpm build              # renders public/index.md -> public/index.html
pnpm dev                # build, then wrangler dev on http://127.0.0.1:8787
```

`public/index.html` is generated and git-ignored. Both `pnpm dev` and
`pnpm run deploy` build it first, and CI regenerates it on every deploy — never
rely on it being committed.

Deploying by hand needs Cloudflare credentials in the environment (or an
interactive `wrangler login`); normally you just push to `main`:

```bash
pnpm run deploy         # note: `run` is required, `deploy` is also a pnpm builtin
```

### Editing content

Edit `public/index.md`. That file is the source of truth for both audiences;
nothing else needs touching.

Two things in it are load-bearing:

- **The first blockquote** becomes the HTML `<meta name="description">`.
- **The `<!-- last-modified:start -->` / `<!-- last-modified:end -->` block** is
  rewritten by `build.js` on every build, so the "Last updated" date is stamped
  automatically at deploy time and is never hand-edited. Because the stamp is
  written into `index.md` itself, agents reading the raw Markdown see it too.

`build.js` fails the build if either is missing, so a broken page cannot reach
`main`.

---

## Verifying the behaviour

With `pnpm dev` running, these are the acceptance checks. Swap
`http://127.0.0.1:8787` for `https://lauren.md` to run them against
production.

```bash
# 1. Browser -> HTML, with Vary: Accept
curl -sD- -o/dev/null -H "Accept: text/html" http://127.0.0.1:8787/

# 2. Agent (curl's default Accept: */*) -> Markdown
curl -sD- -o/dev/null http://127.0.0.1:8787/

# 3. Escape hatch: always Markdown, despite a browser-ish Accept
curl -sD- -o/dev/null -H "Accept: text/html" http://127.0.0.1:8787/index.md

# 4. Same content under the llms.txt convention
curl -s http://127.0.0.1:8787/llms.txt

# 5. Query-param override
curl -sD- -o/dev/null -H "Accept: text/html" "http://127.0.0.1:8787/?format=md"

# 6. Description meta tag sourced from the Markdown blockquote
curl -s -H "Accept: text/html" http://127.0.0.1:8787/ | grep '<meta name="description"'

# 7. Full content is real DOM in the response body, not client-injected
curl -s -H "Accept: text/html" http://127.0.0.1:8787/ | grep -c '<h2>'

# 14. Both variants cache independently — distinct ETags, correct bodies
curl -sD- -o/dev/null -H "Accept: text/html" http://127.0.0.1:8787/ | grep -i etag
curl -sD- -o/dev/null                        http://127.0.0.1:8787/ | grep -i etag
```

Expected: 1 returns `text/html` and 2 returns `text/markdown`, both carrying
`Vary: Accept` and `Cache-Control: public, max-age=3600`; 3, 4 and 5 all return
Markdown; 7 prints `6`; and the two ETags in 14 differ.

An explicit `Accept: text/markdown` returns Markdown even when `text/html` is
also present, so an agent can always ask for the source and get it.

---

## How the visual layer degrades

The human-facing page uses Canvas UI's
[Particle Reveal](https://canvasui.dev/docs/components/particle-reveal) effect:
the document renders as fine grayscale dust and resolves to crisp full colour
around the cursor. It depends on the experimental **html-in-canvas** API
(`layoutsubtree`, `drawElementImage`, `requestPaint`), which almost no browser
ships yet, so it is strictly an enhancement:

| Situation | Result |
| --- | --- |
| html-in-canvas available | Dust effect, revealing around the cursor |
| API missing (most browsers today) | Plain styled document; canvases stay `display: none` |
| WebGL2 unavailable | Init rolls the DOM back and leaves a plain document |
| JavaScript disabled | Plain styled document |
| `prefers-reduced-motion: reduce` | Content renders crisp, no dust animation |

The rendered Markdown is **always** real DOM in the served HTML. The canvas
captures that content; it never replaces it, and the output canvas keeps
`aria-hidden` and `pointer-events: none`.

The stage stays in normal flow at full document height rather than being pinned
to the viewport. Content captured into a canvas is painted but not hit-tested —
it receives no wheel or pointer events — so scrolling has to stay with the body.

### Dark theme only, on purpose

The shader uses its `background` option to tell content pixels apart from empty
backdrop, so the page background and that option must be the **same** colour:

```
lab(2.75381 0 0)
```

Supporting a light theme would mean handing the shader two different
backgrounds, so v1 does not attempt it. `build.js` asserts that `style.css` and
the effect's options still agree on that value and fails the build if they drift.

### Re-vendoring the effect

`public/assets/particle-reveal.js` is vendored, not installed — the upstream
component has zero dependencies, and Canvas UI ships it through shadcn, which
assumes a component-project layout this repo does not have.

Two deviations from upstream are documented in the file's header comment: its
`import { createRectCache } from "../rect-cache"` is a dangling import (no such
item exists in the Canvas UI registry, so `shadcn add` leaves it unresolved), so
that helper is reimplemented inline; and the TypeScript annotations are stripped
so the file runs directly in the browser. No logic was changed.

To refresh it:

```bash
curl -s https://canvasui.dev/r/particle-reveal-vanilla.json \
  | jq -r '.files[0].content' > /tmp/ParticleRevealVanilla.ts
# re-apply the inlined createRectCache, then strip types:
sfw pnpm dlx esbuild /tmp/ParticleRevealVanilla.ts --format=esm --target=es2022
```

Use the **WebGL** build, not the WebGPU/WGSL one.

---

## Cloudflare setup

Done once, by hand — the deploy workflow does not automate it.

1. Point the `lauren.md` nameservers at Cloudflare (free plan is fine).
2. Deploy once so the Worker exists: `pnpm deploy`.
3. In the dashboard, open **Workers & Pages → `lauren-md` → Settings →
   Domains & Routes**, add a **Custom Domain** for `lauren.md`, and add
   `www.lauren.md` as a redirect to the apex if you want one.
4. TLS is automatic; there is no certificate work.

`wrangler.toml` contains a commented-out `[[routes]]` block that would claim the
custom domain on every deploy. It is deliberately left commented so domain
attachment stays a one-time manual step.

### The one setting that is easy to get wrong

```toml
[assets]
run_worker_first = true
```

Without it the static-asset layer answers before the Worker runs, `GET /` always
returns `index.html`, and content negotiation is silently bypassed — the site
looks fine in a browser and serves the wrong thing to every agent.

---

## GitHub Actions

Pushing to `main` builds and deploys automatically. Pull requests run the same
install and build, so a broken page cannot reach `main`.

Two repository secrets are required (**Settings → Secrets and variables →
Actions**):

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token with `Workers Scripts:Edit`. The "Edit Cloudflare Workers" template token is sufficient. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID, from the dashboard sidebar. |

Two more are optional and enable the post-deploy cache purge. The step is
skipped entirely when they are absent, so the deploy never fails for want of
them:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_CACHE_PURGE_TOKEN` | Token with `Cache Purge` permission. |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `lauren.md`. |

---

## Layout

```
build.js                        Markdown -> HTML, plus the last-modified stamp
wrangler.toml                   Worker + static assets config
src/index.js                    Routing and content negotiation (no deps)
public/index.md                 SOURCE OF TRUTH — hand-edited
public/index.html               generated; git-ignored; rebuilt in CI
public/style.css                dark-only styling for the HTML render
public/assets/particle-reveal.js  vendored Canvas UI vanilla WebGL build
.github/workflows/deploy.yml    push to main -> build + deploy
.github/workflows/ci.yml        pull request -> build
```

### Routing

| Request | Response |
| --- | --- |
| `GET /` with `Accept: text/html` | `index.html` as `text/html`, `Vary: Accept` |
| `GET /` with `*/*`, absent, or `text/markdown` | `index.md` as `text/markdown`, `Vary: Accept` |
| `GET /index.md` | raw Markdown, always |
| `GET /llms.txt` | raw Markdown, always (same content) |
| `GET /?format=md` | raw Markdown, always |
| `GET /style.css`, `GET /assets/*` | passthrough to static assets |
| anything else | `302` redirect to `/` |

The Worker has zero runtime dependencies and fetches assets through the
`ASSETS` binding rather than bundling any file contents.
