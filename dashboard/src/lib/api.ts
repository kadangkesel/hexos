// In production (static export served by hexos server), use same origin.
// In dev mode, use the separate API server URL.
export const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== "undefined" && window.location.port !== "7471"
    ? "" // Same origin — served by hexos server
    : "http://127.0.0.1:7470");

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${BASE_URL}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = `${res.status} ${res.statusText}`;
    if (body) {
      try {
        const json = JSON.parse(body);
        message = json.error ?? json.message ?? message;
      } catch {
        message = body;
      }
    }
    throw new ApiError(res.status, message);
  }

  // 204 No Content – nothing to parse
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}
