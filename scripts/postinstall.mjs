const notice =
  '[ContextOS] Automatic patch updates are enabled by default for supported Linux global npm installs; existing user preferences are respected. Only stable patches in the current major and minor version are installed, and updates are skipped while ContextOS clients are active. Disable automatic installs with `contextos updates policy notify`.\n';

if (process.env.CONTEXTOS_SUPPRESS_INSTALL_NOTICE !== '1') {
  process.stderr.write(notice);
  if (process.env.npm_config_global === 'true') {
    process.stderr.write(
      '[ContextOS] Global agent instructions are unchanged. Run `contextos enable --dry-run` to preview optional setup, then `contextos enable` to apply it. Existing-project migration is separate; set CONTEXTOS_SKIP_SETUP=1 to skip it.\n'
    );
  }
}

// Staged self-upgrades must not mutate projects before the package swap commits.
if (process.env.npm_config_global === 'true' && process.env.CONTEXTOS_SKIP_SETUP !== '1') {
  try {
    const { upgradeExistingProjects } = await import('../dist/src/cli/utils/installation-setup.js');
    await upgradeExistingProjects({ cwd: process.env.INIT_CWD });
  } catch (error) {
    process.stderr.write(
      `[ContextOS] Project setup will retry on next use: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}
