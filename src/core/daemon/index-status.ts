/** Shared human-readable diagnostics; JSON callers receive the original metadata. */
export function formatIndexWarning(progress: unknown): string | null {
  if (!progress || typeof progress !== 'object') return null;
  const status = progress as Record<string, unknown>;
  if (!status.failedFileCount) return null;
  const lines = [
    `${status.partial ? 'Partial index' : 'Index failures'}: ${status.failedFileCount} file(s) failed. Retry with contextos reindex --failed.`
  ];
  if (Array.isArray(status.failedFiles))
    for (const failure of status.failedFiles as { path: string; error: string }[])
      lines.push(`  ${failure.path}: ${failure.error}`);
  if (status.failureDetailsTruncated)
    lines.push('  More failures are recorded in failed-index-files.json beside status.json.');
  return lines.join('\n');
}
