# Next.js RSC Boundaries Benchmark

This project evaluates ContextOS's ability to cleanly resolve the barrier between React Server Components (RSC), Client Components, and Server Actions.

## Retrieval Challenge
In Next.js App Router, components often mix boundary directives (`'use server'` and `'use client'`). A standard embedding search for "How does login work?" might just return `page.tsx` or mix up the client-side state with the server-side DB connection. 

ContextOS uses exact AST parsing. It understands that `AuthForm` (Client) imports `authenticateUser` (Server Action), which in turn calls `dbConnect`.

## Expected Graph
```
components/auth-form.tsx (Client)
  ↓ imports authenticateUser
actions/db.ts (Server)
  ↓ calls dbConnect
actions/db.ts
```

## Setup
Run ContextOS within this directory:
```bash
contextos init
```
