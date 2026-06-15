export function unwrapRuntimeResponse<T>(response: unknown, missingMessage: string): T {
  if (isRuntimeFailure(response)) {
    throw new Error(response.error ? String(response.error) : missingMessage);
  }
  if (response === null || response === undefined) {
    throw new Error(missingMessage);
  }
  return response as T;
}

export function isRuntimeFailure(response: unknown): response is { ok: false; error?: unknown } {
  return Boolean(
    response &&
    typeof response === 'object' &&
    (response as { ok?: unknown }).ok === false,
  );
}

export function getRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
