export interface FieldError {
  field: string; // same path format as the server, e.g. "items[0].quantity"
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: FieldError[];

  constructor(message: string, status: number, details: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown; details?: unknown };
    if (typeof body.error === "string") {
      return new ApiError(body.error, res.status, Array.isArray(body.details) ? (body.details as FieldError[]) : []);
    }
  } catch {
    // Not JSON (e.g. the dev proxy could not reach the API): use the generic message.
  }
  return new ApiError(`Request failed (HTTP ${res.status})`, res.status);
}
