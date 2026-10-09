/** A plain-language refusal from a board or sitting action, with its HTTP status and a code the page can act on. */
export class BoardActionError extends Error {
  constructor(message: string, public status: number, public code: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}
