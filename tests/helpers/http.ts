/** Request/response plumbing for route-handler tests. */

export const BASE = "http://localhost:3000";

export function postJson(
  path: string,
  body: unknown,
  cookie?: string,
): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function putJson(
  path: string,
  body: unknown,
  cookie?: string,
): Request {
  return new Request(`${BASE}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function patchJson(
  path: string,
  body: unknown,
  cookie?: string,
): Request {
  return new Request(`${BASE}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function getJson(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

/** The "name=value" pair of the session cookie a response sets. */
export function sessionCookieOf(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("response set no cookie");
  return header.split(";")[0];
}
