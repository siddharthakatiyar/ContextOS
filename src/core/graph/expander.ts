import { RelationshipsRepo } from '../storage/relationships-repo.js';
import { STOPWORDS } from '../../utils/stopwords.js';

export interface ExpandedEntity {
  entity: string;
  relationshipType: string;
  depth: number;
  score: number;
}

// Minimum weight to traverse an edge (low-weight = noise)
const MIN_EDGE_WEIGHT = 0.9;
// If a node has more connections than this, it's a hub (e.g., "license") — skip it
const MAX_CONNECTIONS_THRESHOLD = 30;
// Minimum entity length to consider
const MIN_ENTITY_LENGTH = 3;

function isQualityEntity(entity: string): boolean {
  if (entity.length < MIN_ENTITY_LENGTH) return false;
  if (/^\d+$/.test(entity)) return false;                  // pure number
  if (STOPWORDS.has(entity.toLowerCase())) return false;    // natural language word
  return true;
}

export class GraphExpander {
  private relsRepos: RelationshipsRepo[];

  constructor(relsRepos: RelationshipsRepo | RelationshipsRepo[]) {
    this.relsRepos = Array.isArray(relsRepos) ? relsRepos : [relsRepos];
  }

  public expand(seeds: string[], maxDepth: number = 2, maxNodes: number = 20): ExpandedEntity[] {
    const visited = new Set<string>();
    const queue: { entity: string; depth: number; weight: number; relType?: string }[] = [];
    const pushQueue = (item: { entity: string; depth: number; weight: number; relType?: string }) => {
      queue.push(item);
      queue.sort((a, b) => b.weight - a.weight);
    };
    
    const results: ExpandedEntity[] = [];

    // Only seed with quality entities
    for (const seed of seeds) {
      if (isQualityEntity(seed)) {
        pushQueue({ entity: seed, depth: 0, weight: 1.0 });
      }
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
          relationshipType: current.relType || 'expanded',
          depth: current.depth,
          score: current.weight * Math.pow(0.5, current.depth) // decay by depth
        });
      }

      for (const repo of this.relsRepos) {
        const directNeighbors = repo.findRelated(current.entity);

        // Hub detection: if this entity has too many connections, it's noise
        if (directNeighbors.length > MAX_CONNECTIONS_THRESHOLD) {
          continue;
        }

        for (const rel of directNeighbors) {
          // Weight threshold: only traverse meaningful edges
          if (rel.weight < MIN_EDGE_WEIGHT) continue;

          const neighbor = rel.source === current.entity ? rel.target : rel.source;
          if (!visited.has(neighbor) && isQualityEntity(neighbor)) {
            pushQueue({ 
              entity: neighbor, 
              depth: current.depth + 1, 
              weight: rel.weight,
              relType: rel.relationshipType
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

