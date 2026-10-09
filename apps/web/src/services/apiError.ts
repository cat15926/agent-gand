export class ApiError extends Error {
  constructor(message: string, public status: number, public fieldErrors: Record<string, string>, public code?: string) { super(message); }
}
