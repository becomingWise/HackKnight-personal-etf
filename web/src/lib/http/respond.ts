import { corsHeaders } from "./cors";

/** JSON response with CORS for the frontend origins and an explicit UTF-8 charset. */
export function json(
  request: Request,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      // Explicit charset: Windows PowerShell otherwise misreads non-ASCII characters.
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

/** The API's common error shape: `{ "error": { "code", "message" } }`. */
export function error(
  request: Request,
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return json(request, status, { error: { code, message } }, extra);
}

/** Public base URL: APP_BASE_URL when set to a real host, otherwise the request's own origin. */
export function baseUrl(request: Request): string {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured;
  return new URL(request.url).origin;
}
