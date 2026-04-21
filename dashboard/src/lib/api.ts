export const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8080";

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
