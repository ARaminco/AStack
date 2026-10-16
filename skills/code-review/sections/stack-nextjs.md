# Next.js 16

Read the installed version in `package.json`/lockfile first and verify any API you
cite against that version's upgrade guide; this list assumes 16.x.

## Version 16 breaking points
- `middleware.ts` is renamed to `proxy.ts` (export `proxy`); a leftover
  middleware file or matcher that no longer runs is a silent auth gap.
- Request APIs are async only: `params`, `searchParams`, `cookies()`,
  `headers()`, `draftMode()` must be awaited.
- Turbopack is the default bundler; custom `webpack()` config is ignored unless
  the build opts out. Check plugins that relied on it.
- `revalidateTag()` takes a cache-life profile as its second argument;
  `updateTag()` is for read-your-writes inside Server Actions.
- `next lint` is gone; lint runs through ESLint or Biome directly. A CI step
  still calling it fails or silently skips.
- Cache Components (`cacheComponents`, `"use cache"`, `cacheLife`) replace the
  old experimental PPR flags.
- `images.domains` is deprecated: use narrow `remotePatterns`.

## Security
- **Server Actions are public POST endpoints.** Each one authenticates,
  authorizes and validates its input (for example with zod) itself. Hidden
  buttons are not authorization.
- Auth checked only in `proxy.ts`/middleware is not enough; re-check next to
  the data (route handler, action, data access layer).
- Route handlers (`app/**/route.ts`) without auth, CORS or rate limits.
- Secrets in `NEXT_PUBLIC_*` variables ship to the browser.
- Server Components passing whole records (password hash, tokens, internal
  notes) to Client Components; use a DTO and the `server-only` package.
- `"use cache"`, `unstable_cache` or fetch caching of per-user data without the
  user in the key: cross-user leaks.
- Open redirects from a `next`/`returnTo` parameter; `dangerouslySetInnerHTML`
  on CMS or user content.
- `remotePatterns` with `**` hosts lets anyone use the image optimizer.

## Performance and correctness
- `"use client"` high in the tree (layouts) pulling server-only code and big
  dependencies into the bundle.
- Sequential `await` waterfalls that could be `Promise.all`; missing `Suspense`
  boundaries around slow data.
- `export const dynamic = 'force-dynamic'` or `cache: 'no-store'` sprinkled to
  fix a stale-data bug instead of tagging and revalidating.
- Hydration mismatches: `Date`, locale formatting, `Math.random()` or
  `window` reads during render.
- `generateMetadata` and `generateStaticParams` fetching without caching or
  error handling; missing `notFound()` for unknown slugs.
