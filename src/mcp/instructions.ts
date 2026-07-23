export const MCP_SERVER_INSTRUCTIONS =
  'Before searching or exploring code in this workspace with grep, file search, or a general-purpose ' +
  'search/explore agent, call get_context first for questions about where or how something is ' +
  'implemented, service relationships, or conventions. It returns precise, indexed answers directly ' +
  'from this workspace and is faster and more accurate than ad-hoc file search for those questions. ' +
  'Fall back to broad file search only for tasks get_context does not cover (e.g. renaming across ' +
  'files, running commands, or content get_context returns no results for).';
