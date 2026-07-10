export interface ParsedDocument {
  filePath: string;
  frontmatter?: Record<string, unknown>;
  sections: Section[];
}

export interface Section {
  title: string | null;
  depth: number;
  content: string;
  startLine: number;
  endLine: number;
  children: Section[];
  metadata: {
    hasCodeBlocks: boolean;
    hasTables: boolean;
    hasLists: boolean;
    wordCount: number;
  };
}

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'method' | 'import' | 'export' | 'variable' | 'type' | 'struct' | 'enum';
  startLine: number;
  endLine: number;
  body: string;
  docstring?: string;
  parent?: string;
}

export interface ParsedCodeDocument {
  filePath: string;
  language: string;
  symbols: CodeSymbol[];
  /** Original file text — used for whole-file fallback chunks. */
  rawContent?: string;
}
