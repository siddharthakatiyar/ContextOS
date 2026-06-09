import { ParsedDocument, Section } from './types.js';

export function parseMarkdown(filePath: string, rawContent: string): ParsedDocument {
  // Extract frontmatter if any
  let content = rawContent;
  let frontmatter: Record<string, unknown> | undefined;

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatterMatch) {
    try {
      // Basic YAML parsing for frontmatter (avoiding heavy yaml dep for now)
      frontmatter = {};
      const lines = frontmatterMatch[1].split('\n');
      for (const line of lines) {
        const [key, ...values] = line.split(':');
        if (key && values.length > 0) {
          frontmatter[key.trim()] = values.join(':').trim();
        }
      }
    } catch (e) {
      // ignore frontmatter parse errors
    }
    content = content.substring(frontmatterMatch[0].length);
  }

  const lines = content.split('\n');
  const sections: Section[] = [];
  
  let currentSection: Section = createSection(null, 0, 1);
  let currentContentLines: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch && !inCodeBlock) {
      // Save current section
      currentSection.content = currentContentLines.join('\n').trim();
      currentSection.endLine = i;
      currentSection.metadata = analyzeContent(currentSection.content);
      
      // We push the section if it has content or a title
      if (currentSection.content.length > 0 || currentSection.title) {
        sections.push(currentSection);
      }

      // Start new section
      const depth = headingMatch[1].length;
      const title = headingMatch[2].trim();
      currentSection = createSection(title, depth, i + 1);
      currentContentLines = [];
    } else {
      currentContentLines.push(line);
    }
  }

  // Save the last section
  currentSection.content = currentContentLines.join('\n').trim();
  currentSection.endLine = lines.length;
  currentSection.metadata = analyzeContent(currentSection.content);
  if (currentSection.content.length > 0 || currentSection.title) {
    sections.push(currentSection);
  }

  // Build tree structure
  const rootSections = buildTree(sections);

  return {
    filePath,
    frontmatter,
    sections: rootSections,
  };
}

function createSection(title: string | null, depth: number, startLine: number): Section {
  return {
    title,
    depth,
    startLine,
    endLine: startLine,
    content: '',
    children: [],
    metadata: {
      hasCodeBlocks: false,
      hasTables: false,
      hasLists: false,
      wordCount: 0,
    }
  };
}

function analyzeContent(content: string) {
  return {
    hasCodeBlocks: /```/.test(content),
    hasTables: /\|.+\|.+\|/.test(content),
    hasLists: /^\s*[-*+]\s|^\s*\d+\.\s/m.test(content),
    wordCount: content.split(/\s+/).filter(w => w.length > 0).length,
  };
}

function buildTree(sections: Section[]): Section[] {
  const root: Section[] = [];
  const stack: Section[] = [];

  for (const section of sections) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= section.depth && section.depth > 0) {
      stack.pop();
    }

    if (stack.length === 0 || section.depth === 0) {
      root.push(section);
    } else {
      stack[stack.length - 1].children.push(section);
    }

    stack.push(section);
  }

  return root;
}
