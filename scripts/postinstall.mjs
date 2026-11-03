const notice =
  '[ContextOS] Automatic patch updates are enabled by default for supported Linux global npm installs; existing user preferences are respected. Only stable patches in the current major and minor version are installed, and updates are skipped while ContextOS clients are active. Disable automatic installs with `contextos updates policy notify`.\n';

if (process.env.CONTEXTOS_SUPPRESS_INSTALL_NOTICE !== '1') {
  process.stderr.write(notice);
}
