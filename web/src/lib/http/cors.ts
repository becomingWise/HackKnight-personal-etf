// CORS for endpoints the team's static frontend calls from another origin.

/** Where the frontend is served from: GitHub Pages and the local preview servers. */
export const ALLOWED_ORIGINS = [
  "https://becomingwise.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export function isAllowedOrigin(origin: string | null, extra: string[] = extraOrigins()): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || extra.includes(origin);
}

/** Extra origins from CORS_ORIGINS (comma-separated), e.g. a custom domain added later. */
function extraOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { Vary: "Origin" };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin!;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
    // Lets browser code read the cache and rate-limit headers.
    headers["Access-Control-Expose-Headers"] = "X-Cache, X-Cache-Age, Retry-After";
  }
  return headers;
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
