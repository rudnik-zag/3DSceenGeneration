import { NextResponse } from "next/server";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

function toDebugError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return {
    message: String(error)
  };
}

export function toApiErrorResponse(error: unknown, fallbackMessage = "Internal server error") {
  if (isHttpError(error)) {
    return NextResponse.json(
      {
        error: error.code,
        message: error.message,
        details: error.details
      },
      { status: error.status }
    );
  }

  return NextResponse.json(
    {
      error: "internal_error",
      message: fallbackMessage,
      ...(process.env.NODE_ENV !== "production" ? { debug: toDebugError(error) } : {})
    },
    { status: 500 }
  );
}
