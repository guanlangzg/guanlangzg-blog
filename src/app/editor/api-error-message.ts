type ApiFailurePayload = {
  message?: unknown;
  error?: { message?: unknown } | null;
};

// Editor API failures use { error: { code, message, ... } }; older/private
// endpoints still answer with a top-level { message }.
export function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const candidate = payload as ApiFailurePayload;
  const nestedMessage = candidate.error?.message;

  if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
    return nestedMessage;
  }

  if (typeof candidate.message === 'string' && candidate.message.trim()) {
    return candidate.message;
  }

  return fallback;
}
