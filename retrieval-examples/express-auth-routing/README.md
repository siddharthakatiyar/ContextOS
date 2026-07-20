# Express Auth Routing Benchmark

This project demonstrates ContextOS's ability to resolve and track dependency graphs through standard Express middleware arrays.

## Retrieval Challenge
In monolithic Express apps, routes often depend on dozens of middleware and controller files. If an LLM needs to understand "How does authentication work for the profile route?", a traditional vector DB will return the massive `routes.ts` file and maybe the `user.ts` controller, completely missing the authentication middleware and the underlying JWT services.

ContextOS uses **Graph Expansion** to trace the router execution flow:

```
routes.ts (setupRoutes)
  ↓ imports requireAuth
middleware/auth.ts (requireAuth)
  ↓ imports verifyToken
services/jwt.ts (verifyToken)
```

## Setup
Run ContextOS within this directory to index the mock files:
```bash
contextos init
```
