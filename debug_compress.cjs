const fs = require('fs');

function estimateTokens(text) {
  if (!text) return 0;
  const codeRatio = (text.match(/[{}();=<>\[\]\.,+*\/-]/g)?.length || 0) / text.length;
  const clampedRatio = Math.min(Math.max(codeRatio, 0), 0.5);
  const charsPerToken = 4.5 - (clampedRatio * 2 * 1.5);
  return Math.ceil(text.length / charsPerToken);
}

function compressChunks(chunks, maxTokens) {
  let currentTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
  const compressed = [...chunks];

  while (currentTokens > maxTokens && compressed.length > 0) {
    const dropped = compressed.pop();
    const diff = currentTokens - maxTokens;
    if (diff < dropped.tokenCount && diff > 0) {
      const ratio = 1 - (diff / dropped.tokenCount);
      const lines = dropped.content.split('\n');
      const keepLines = Math.max(1, Math.floor(lines.length * ratio));
      let truncatedContent = lines.slice(0, keepLines).join('\n');
      
      const expectedCharLen = Math.max(100, dropped.content.length * ratio);
      if (truncatedContent.length > expectedCharLen * 1.5) {
        truncatedContent = dropped.content.slice(0, Math.floor(expectedCharLen));
      }
      
      truncatedContent += '\n\n[...truncated]';
      const keepTokens = Math.floor(dropped.tokenCount * ratio);
      compressed.push({
        ...dropped,
        content: truncatedContent,
        tokenCount: keepTokens
      });
      currentTokens -= (dropped.tokenCount - keepTokens);
      break;
    } else {
      currentTokens -= dropped.tokenCount;
    }
  }
  return { compressed: compressed.map(c => ({...c, content: c.content.substring(0, 50) + '...'})), currentTokens };
}

const mockChunks = [
  { tokenCount: 50, content: "line1\nline2\n" },
  { tokenCount: 319000, content: "a".repeat(1000000) }
];

console.log(compressChunks(mockChunks, 4000));
