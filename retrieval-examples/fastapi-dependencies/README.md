# FastAPI Dependencies Benchmark

This project tests ContextOS's ability to extract Python decorators and dependency injection flows via `Depends()`.

## Retrieval Challenge
FastAPI heavily utilizes decorators (`@app.get`) and implicit dependency injection inside function signatures. A standard search will return the router file, but often fails to fetch the underlying dependency definitions unless it strictly understands Python AST kwargs.

ContextOS uses Tree-sitter to parse Python kwargs and traces the `Depends()` function pointers back to their source.

## Expected Graph
```
routers/users.py (read_users_me)
  ↓ imports get_current_user, get_db_session
dependencies.py (get_current_user)
  ↓ imports User
models/user.py (User)
```

## Setup
Run ContextOS within this directory:
```bash
contextos init
```
