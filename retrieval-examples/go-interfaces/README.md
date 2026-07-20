# Go Interfaces Benchmark

This project tests ContextOS's ability to navigate implicit package-level visibility and interface satisfaction in Go.

## Retrieval Challenge
In Go, variables and structs are accessible package-wide without explicit imports. For example, `postgres.go` can reference `User` defined in `store.go` because they are both in `package store`. A naive grep or text search will fail to trace this dependency because there is no explicit `import "store/User"` statement.

ContextOS understands Go package boundaries natively.

## Expected Graph
```
main.go (main)
  ↓ imports store package
internal/store/postgres.go (NewPostgresStore)
  ↓ implicitly relies on User
internal/store/store.go (User)
```

## Setup
Run ContextOS within this directory:
```bash
contextos init
```
