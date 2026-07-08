import { ParsedCodeDocument, CodeSymbol } from './types.js';

export function parseConfig(filePath: string, content: string): ParsedCodeDocument {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const symbols: CodeSymbol[] = [];

  const lines = content.split('\n');
  
  if (ext === 'json') {
    // Basic regex to find top-level JSON keys and values
    for (let i = 0; i < lines.length; i++) {
      const jsonKeyRegex = /^ {2}"([^"]+)":\s*(.*)/;
      const rootRegex = /^"([^"]+)":\s*(.*)/;
      const line = lines[i];
      let match;
      // Also match root level
      if ((match = rootRegex.exec(line)) !== null || (match = jsonKeyRegex.exec(line)) !== null) {
        let value = match[2].trim();
        if (value.endsWith(',')) value = value.slice(0, -1);
        symbols.push({
          name: match[1],
          kind: 'variable',
          startLine: i + 1,
          endLine: i + 1,
          body: value
        });
      }
    }
  } else if (ext === 'yml' || ext === 'yaml') {
    // Basic regex to find top-level YAML keys and values
    for (let i = 0; i < lines.length; i++) {
      const yamlKeyRegex = /^([a-zA-Z0-9_-]+):\s*(.*)/;
      const line = lines[i];
      let match;
      if ((match = yamlKeyRegex.exec(line)) !== null) {
        symbols.push({
          name: match[1],
          kind: 'variable',
          startLine: i + 1,
          endLine: i + 1,
          body: match[2].trim() || match[0].trim()
        });
      }
    }
  } else if (ext === 'toml' || ext === 'ini') {
    // Basic regex to find TOML/INI sections and key-values
    for (let i = 0; i < lines.length; i++) {
      const tomlSectionRegex = /^\[([^\]]+)\]/;
      const tomlKeyRegex = /^([a-zA-Z0-9_-]+)\s*=\s*(.*)/;
      const line = lines[i];
      let match;
      if ((match = tomlSectionRegex.exec(line)) !== null) {
        symbols.push({
          name: match[1],
          kind: 'struct', // using struct as a proxy for section
          startLine: i + 1,
          endLine: i + 1,
          body: match[0].trim()
        });
      } else if ((match = tomlKeyRegex.exec(line)) !== null) {
        symbols.push({
          name: match[1],
          kind: 'variable',
          startLine: i + 1,
          endLine: i + 1,
          body: match[2].trim()
        });
      }
    }
  }

  // Determine language mapping
  let language = ext;
  if (ext === 'yml') language = 'yaml';

  return {
    filePath,
    language,
    symbols
  };
}
