import { describe, it, expect, vi } from 'vitest';
import { GraphExpander } from '../../src/core/graph/expander.js';
import { RelationshipsRepo } from '../../src/core/storage/relationships-repo.js';

describe('GraphExpander', () => {
  it('respects depth limits and breaks cycles', () => {
    const mockRepo = {
      findRelated: vi.fn((entity) => {
        if (entity === 'NodeA') return [{ source: 'NodeA', target: 'NodeB', relationshipType: 'calls', weight: 1.0 }];
        if (entity === 'NodeB') return [
          { source: 'NodeB', target: 'NodeC', relationshipType: 'calls', weight: 1.0 },
          { source: 'NodeB', target: 'NodeA', relationshipType: 'calls', weight: 1.0 }
        ];
        if (entity === 'NodeC') return [{ source: 'NodeC', target: 'NodeD', relationshipType: 'calls', weight: 1.0 }];
        return [];
      }),
    } as unknown as RelationshipsRepo;

    const expander = new GraphExpander(mockRepo);
    
    const results = expander.expand(['NodeA'], 2, 10);
    const entities = results.map(r => r.entity);
    
    expect(entities).toContain('NodeB');
    expect(entities).toContain('NodeC');
    expect(entities).not.toContain('NodeA');
    expect(entities).not.toContain('NodeD');
  });

  it('respects maxNodes limit', () => {
    const mockRepo = {
      findRelated: vi.fn((entity) => {
        if (entity === 'Root') {
          return [
            { source: 'Root', target: 'Child1', relationshipType: 'calls', weight: 1.0 },
            { source: 'Root', target: 'Child2', relationshipType: 'calls', weight: 1.0 },
            { source: 'Root', target: 'Child3', relationshipType: 'calls', weight: 1.0 },
          ];
        }
        return [];
      }),
    } as unknown as RelationshipsRepo;

    const expander = new GraphExpander(mockRepo);
    
    const results = expander.expand(['Root'], 2, 2);
    expect(results.length).toBe(2);
  });
});
