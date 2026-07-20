# Canonical Queries

Run these queries using the ContextOS CLI to evaluate retrieval quality.

```bash
# Target: Graph Expansion (Middleware -> Service)
contextos query "How does authentication work for the profile route?"

# Target: Graph Expansion (Controller -> Model)
contextos query "Where is the database accessed for the user profile?"

# Target: Semantic resolution
contextos query "How is the JWT generated?"
```
