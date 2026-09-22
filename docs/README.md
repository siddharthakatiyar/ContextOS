# ContextOS documentation site

This directory contains the Next.js documentation site for ContextOS. The app
router lives under `src/app/`, and the site reads source links from the
repository root one directory above this workspace.

## Getting started

From the repository root:

```bash
npm run dev --workspace docs
```

Open <http://localhost:3000> in a browser. The app entrypoint is
`docs/src/app/page.tsx`; edits there auto-update in development.

Run the documentation checks with:

```bash
npm run lint --workspace docs
npm run build --workspace docs
```

The docs site is a reference frontend. It does not index or publish repository
state databases.
