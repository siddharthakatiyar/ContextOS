/** A read crossed a checkout/readiness transition; retry only from a fresh scope. */
export class ReadinessChangedError extends Error {}

export interface UnavailableSource {
  repoId: string;
  name: string;
  error: string;
  retryable?: boolean;
}

export function unavailableError(message: string, sources: UnavailableSource[]): Error {
  const detail = `${message}: ${sources.map((s) => `${s.name}: ${s.error}`).join('; ')}`;
  return sources.length && sources.every((s) => s.retryable)
    ? new ReadinessChangedError(detail)
    : new Error(detail);
}
