# Cyclic Dependencies Benchmark

This project tests the resilience of the Graph Expansion algorithm.

## Retrieval Challenge
File A imports from File B, and File B imports from File A. If the ContextOS BFS (Breadth-First Search) graph expander does not maintain a strict `visited` set or respect the `maxDepth` limit, querying this repository will cause an infinite loop and crash the daemon via an Out-of-Memory (OOM) error.

## Expected Behavior
ContextOS should seamlessly retrieve both `a.ts` and `b.ts` without hanging. The BFS should terminate early because the node has already been visited.

## Setup
Run ContextOS within this directory:
```bash
contextos init
```
