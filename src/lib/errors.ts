export type ApiErrorCode = 'SESSION_EXPIRED' | 'INVALID_CREDENTIALS' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'WARD_TAKEN';

/** An error that is sent to the client as { message, code, fieldErrors }. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function fail(status: number, code: ApiErrorCode, message: string, fieldErrors?: Record<string, string>): never {
  throw new ApiError(status, code, message, fieldErrors);
}

/** Throws a 400 with the collected field errors, if there are any. */
export function failIfErrors(errors: Record<string, string>, message = 'Please correct the highlighted fields.'): void {
  if (Object.keys(errors).length) fail(400, 'VALIDATION', message, errors);
}
