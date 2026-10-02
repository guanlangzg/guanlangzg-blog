export function ToolFieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p id={`${id}-error`} className="mt-1 text-xs text-error-600" role="alert">
      {message}
    </p>
  );
}
