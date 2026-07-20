---
name: vercel-build-debug
description: Diagnose and fix Vercel deployment build failures from pasted logs
---

# Vercel Build Debug

Use this skill when the user pastes a Vercel build log and asks for help fixing it.

## Procedure

1. **Parse the build log** — Extract the exact error message, failing step, and any file paths mentioned.

2. **Classify the error** by category:
   - **Module not found** → check import paths, missing dependencies, path aliases
   - **TypeScript error** → run `npx tsc --noEmit` locally to reproduce, fix types
   - **Webpack/Terser/ESM error** → check `next.config.js` for `experimental.serverComponentsExternalPackages`, webpack externals, or custom loaders
   - **Build timeout** → check bundle size, large dependencies, missing `output: 'standalone'`
   - **Memory exceeded** → check for large static assets in `public/`, missing `.gitignore` entries
   - **Dependency resolution** → check `package.json` for conflicts, try `npm install` fresh
   - **Environment variable** → verify `.env.local` vs Vercel dashboard env vars

3. **Apply fix** — Edit the minimal set of files needed. For Next.js + onnxruntime-web:
   - Server: `experimental.serverComponentsExternalPackages: ['onnxruntime-web']` in `next.config.js`
   - Client: Custom webpack loader to replace `import.meta` before Terser (see `webpack-loader-import-meta.js`)
   - Alternative: `config.optimization.minimize = false` as last resort

4. **Verify locally** — Run `npx tsc --noEmit` and `npx next build` (or `npx next dev`) to confirm the fix before pushing.

5. **Commit and push** — `git add -A && git commit -m "fix: <description>" && git push`

## Common Vercel + Next.js 14 Fixes

- **`import.meta.url` in ESM bundles** (onnxruntime-web): Custom webpack loader or `minimize = false`
- **Server component external packages**: Add to `experimental.serverComponentsExternalPackages`
- **Large `public/` directory**: Add heavy files to `.vercelignore` or serve from CDN
- **Middleware blocking static files**: Check `matcher` config excludes `.mp4`, `.webm`, etc.
- **Supabase WebSocket duplicate connections**: Memoize client with `createClient()` singleton
