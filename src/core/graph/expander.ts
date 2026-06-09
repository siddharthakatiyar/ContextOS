import { RelationshipsRepo } from '../storage/relationships-repo.js';

export interface ExpandedEntity {
  entity: string;
  relationshipType: string;
  depth: number;
  score: number;
}

export class GraphExpander {
  private relsRepos: RelationshipsRepo[];

  constructor(relsRepos: RelationshipsRepo | RelationshipsRepo[]) {
    this.relsRepos = Array.isArray(relsRepos) ? relsRepos : [relsRepos];
  }

  public expand(seeds: string[], maxDepth: number = 2, maxNodes: number = 20): ExpandedEntity[] {
    const visited = new Set<string>();
    const queue: { entity: string; depth: number; weight: number }[] = [];
    const results: ExpandedEntity[] = [];

    for (const seed of seeds) {
      queue.push({ entity: seed, depth: 0, weight: 1.0 });
    }

    while (queue.length > 0 && results.length < maxNodes) {
      const current = queue.shift()!;
      
      if (visited.has(current.entity) || current.depth > maxDepth) {
        continue;
      }
      visited.add(current.entity);

      if (current.depth > 0) {
        results.push({
          entity: current.entity,
          relationshipType: 'expanded',
          depth: current.depth,
          score: current.weight * Math.pow(0.5, current.depth) // decay by depth
        });
      }

      for (const repo of this.relsRepos) {
        const directNeighbors = repo.findRelated(current.entity);
        for (const rel of directNeighbors) {
          const neighbor = rel.source === current.entity ? rel.target : rel.source;
          if (!visited.has(neighbor)) {
            queue.push({ 
              entity: neighbor, 
              depth: current.depth + 1, 
              weight: rel.weight 
            });
          }
        }
      }
    }

    // Sort by depth ASC, score DESC
    results.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return b.score - a.score;
    });

    return results;
  }
}
