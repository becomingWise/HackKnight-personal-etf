// Browser-side calls to our own API for the product pages. A failed call rejects with an
// ApiFailure, which carries what productView.plainError needs and never a raw server message
// (except a clarification, whose message is the agent's question).
import type { Failure } from "./productView";

export class ApiFailure extends Error implements Failure {
  status?: number;
  code?: string;
  network?: boolean;
  /** Ideas to choose from when the agent asks instead of answering (422 needs_clarification). */
  options?: string[];
  constructor(detail: Failure & { message?: string; options?: string[] }) {
    super(detail.message ?? "The request failed.");
    this.name = "ApiFailure";
    Object.assign(this, detail);
  }
}

/** One id per browser tab: the agent keeps stated preferences per session. */
function sessionId(): string {
  try {
    const stored = sessionStorage.getItem("myetf.sessionId");
    if (stored) return stored;
    const created = crypto.randomUUID();
    sessionStorage.setItem("myetf.sessionId", created);
    return created;
  } catch {
    return "browser";
  }
}

async function read<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ApiFailure({ network: true });
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: { code?: unknown; message?: unknown; options?: unknown } })
      ?.error;
    throw new ApiFailure({
      status: response.status,
      code: typeof error?.code === "string" ? error.code : undefined,
      message: typeof error?.message === "string" ? error.message : undefined,
      options: Array.isArray(error?.options)
        ? error.options.filter((option): option is string => typeof option === "string")
        : undefined,
    });
  }
  if (data === null) throw new ApiFailure({ status: response.status });
  return data as T;
}

export const post = <T>(path: string, body?: unknown) =>
  read<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const get = <T>(path: string) => read<T>(path, {});

export const asFailure = (err: unknown): Failure =>
  err instanceof ApiFailure ? err : { status: undefined };
