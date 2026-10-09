import type { RenderErrorCode } from "../render-jobs";

/** A job failure with the plain code the data room stores (render child only). */
export class ChildJobError extends Error {
  constructor(public readonly code: RenderErrorCode, message: string) {
    super(message);
    this.name = "ChildJobError";
  }
}
