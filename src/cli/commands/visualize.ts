import { Command } from 'commander';
import { DB } from '../../core/storage/database.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const visualizeCommand = new Command('visualize')
  .description('Generate an HTML visualization of the context graph')
  .option('-o, --out <path>', 'Output path for HTML file', 'contextos-graph.html')
  .action(async (options) => {
    console.log('Generating context graph visualization...');
    const db = new DB();

    // Query chunks and relationships
    const chunks = db
      .getInstance()
      .prepare('SELECT id, source_file, symbol_name FROM chunks')
      .all() as any[];
    const relationships = db
      .getInstance()
      .prepare('SELECT source_chunk_id, target, relationship_type FROM relationships')
      .all() as any[];

    // We need to map nodes.
    // Chunks are nodes, and expanded entities are also nodes.
    const nodes = new Map();
    const edges = [];

    // Add chunks
    for (const c of chunks) {
      nodes.set(c.id, {
        id: c.id,
        label: c.symbol_name || path.basename(c.source_file),
        group: 'chunk',
        title: c.source_file
      });
    }

    // Add relationships
    for (const r of relationships) {
      const sourceId = r.source_chunk_id;
      // We hash the target entity string to get a consistent ID
      const targetId =
        'entity_' + crypto.createHash('md5').update(r.target).digest('hex').slice(0, 8);

      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          label: r.target,
          group: 'entity'
        });
      }

      edges.push({
        from: sourceId,
        to: targetId,
        label: r.relationship_type,
        arrows: 'to'
      });
    }

    const graphData = {
      nodes: Array.from(nodes.values()),
      edges: edges
    };

    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>ContextOS Graph</title>
  <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style type="text/css">
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; background-color: #1e1e1e; color: #fff; font-family: sans-serif; }
    #mynetwork { width: 100%; height: 100vh; }
  </style>
</head>
<body>
<div id="mynetwork"></div>
<script type="text/javascript">
  const nodes = new vis.DataSet(${JSON.stringify(graphData.nodes).replace(/</g, '\\u003c')});
  const edges = new vis.DataSet(${JSON.stringify(graphData.edges).replace(/</g, '\\u003c')});
  const container = document.getElementById('mynetwork');
  const data = { nodes: nodes, edges: edges };
  const options = {
    nodes: {
      shape: 'dot',
      size: 16,
      font: { color: '#ffffff' }
    },
    edges: {
      color: '#666666',
      font: { color: '#aaaaaa', size: 10, align: 'middle' }
    },
    groups: {
      chunk: { color: { background: '#007ACC', border: '#005a9e' } },
      entity: { color: { background: '#28A745', border: '#1e7e34' } }
    },
    layout: {
      improvedLayout: false
    },
    physics: {
      forceAtlas2Based: { gravitationalConstant: -50, centralGravity: 0.01, springLength: 100, springConstant: 0.08 },
      maxVelocity: 50,
      solver: 'forceAtlas2Based',
      timestep: 0.35,
      stabilization: { enabled: true, iterations: 100, updateInterval: 25 }
    }
  };
  const network = new vis.Network(container, data, options);
  
  // Show physics progress if desired, but vis-network will now yield to browser
  network.on("stabilizationProgress", function(params) {
      console.log("Stabilizing: " + params.iterations + " / " + params.total);
  });
</script>
</body>
</html>`;

    const outPath = path.resolve(process.cwd(), options.out);
    fs.writeFileSync(outPath, htmlContent);
    console.log(`Graph visualization saved to ${outPath}`);
    db.close();
  });
