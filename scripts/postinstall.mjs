const notice =
  '[ContextOS] Automatic patch updates are enabled by default for supported Linux global npm installs; existing user preferences are respected. Only stable patches in the current major and minor version are installed, and updates are skipped while ContextOS clients are active. Disable automatic installs with `contextos updates policy notify`.\n';

if (process.env.CONTEXTOS_SUPPRESS_INSTALL_NOTICE !== '1') {
  process.stderr.write(notice);
}

// npm supplies this flag for global installs. Local installs never alter agent instructions.
if (process.env.npm_config_global === 'true' && process.env.CONTEXTOS_GLOBAL_INSTRUCTIONS !== '0') {
  try {
    const { enableGlobalAgentInstructions } = await import('../dist/src/cli/utils/global-agent-setup.js');
    const results = enableGlobalAgentInstructions();
    for (const result of results) {
      if (result.status === 'not-installed' || result.status === 'unchanged') continue;
      process.stderr.write(`[ContextOS] ${result.agent}: ${result.status}${result.message ? ` — ${result.message}` : ''}\n`);
    }
    if (results.some((result) => result.status === 'error')) {
      process.stderr.write('[ContextOS] Some global instructions could not be installed. Run `contextos enable` to retry.\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`[ContextOS] Could not install global instructions: ${error instanceof Error ? error.message : String(error)}. Run \`contextos enable\` to retry.\n`);
    process.exitCode = 1;
  }
}
