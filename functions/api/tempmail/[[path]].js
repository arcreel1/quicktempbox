const DEFAULT_BASE_URL = "https://api.mail.tm";

function getBaseUrl(env) {
    return (env?.MAILTM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function parseCookies(cookieHeader = "") {
    return cookieHeader
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
            const [key, ...rest] = part.split("=");

            if (key) {
                acc[key] = decodeURIComponent(rest.join("="));
            }

            return acc;
        }, {});
}

function getRoutePath(request, params) {
    const pathParts = params?.path || [];
    const route = "/" + pathParts.join("/");

    return route === "/" ? "/" : route;
}

function jsonResponse(status, payload, headers = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers,
        },
    });
}

function buildSessionCookie(token, env) {
    const name = env?.TM_SESSION_COOKIE_NAME || "tm_session";
    const maxAge = Number(env?.TM_SESSION_MAX_AGE || 3600);

    return [
        `${name}=${encodeURIComponent(token)}`,
        "Path=/",
        `Max-Age=${maxAge}`,
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
    ].join("; ");
}

function clearSessionCookie(env) {
    const name = env?.TM_SESSION_COOKIE_NAME || "tm_session";

    return [
        `${name}=`,
        "Path=/",
        "Max-Age=0",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
    ].join("; ");
}

function readSessionToken(cookieHeader, env) {
    const name = env?.TM_SESSION_COOKIE_NAME || "tm_session";
    const cookies = parseCookies(cookieHeader);

    return cookies[name] || null;
}

async function upstreamJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();

    let data = null;

    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = {
            message: text || "Unexpected upstream response",
        };
    }

    return {
        ok: res.ok,
        status: res.status,
        data,
    };
}

export async function onRequest(context) {
    const { request, env, params } = context;

    try {
        const method = request.method;
        const route = getRoutePath(request, params);
        const baseUrl = getBaseUrl(env);

        /*
         * Handle OPTIONS
         */
        if (method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    Allow: "GET, POST, OPTIONS",
                },
            });
        }

        /*
         * GET /api/tempmail/domains
         */
        if (method === "GET" && route === "/domains") {
            const upstream = await upstreamJson(
                `${baseUrl}/domains`
            );

            return jsonResponse(
                upstream.status,
                upstream.data || {}
            );
        }

        /*
         * POST /api/tempmail/accounts
         */
        if (method === "POST" && route === "/accounts") {
            let payload = {};

            try {
                payload = await request.json();
            } catch {
                return jsonResponse(400, {
                    message: "Invalid JSON body",
                });
            }

            const upstream = await upstreamJson(
                `${baseUrl}/accounts`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify(payload),
                }
            );

            return jsonResponse(
                upstream.status,
                upstream.data || {}
            );
        }

        /*
         * POST /api/tempmail/session
         *
         * Creates a Mail.tm token and stores it
         * in an HttpOnly cookie.
         */
        if (method === "POST" && route === "/session") {
            let payload = {};

            try {
                payload = await request.json();
            } catch {
                return jsonResponse(400, {
                    message: "Invalid JSON body",
                });
            }

            const upstream = await upstreamJson(
                `${baseUrl}/token`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify(payload),
                }
            );

            if (
                !upstream.ok ||
                !upstream.data ||
                !upstream.data.token
            ) {
                return jsonResponse(
                    upstream.status,
                    upstream.data || {
                        message: "Failed to create session",
                    }
                );
            }

            return jsonResponse(
                200,
                { ok: true },
                {
                    "Set-Cookie": buildSessionCookie(
                        upstream.data.token,
                        env
                    ),
                }
            );
        }

        /*
         * POST /api/tempmail/logout
         */
        if (method === "POST" && route === "/logout") {
            return jsonResponse(
                200,
                { ok: true },
                {
                    "Set-Cookie": clearSessionCookie(env),
                }
            );
        }

        /*
         * GET /api/tempmail/messages
         *
         * GET /api/tempmail/messages/:id
         */
        if (
            method === "GET" &&
            (
                route === "/messages" ||
                route.startsWith("/messages/")
            )
        ) {
            const cookieHeader =
                request.headers.get("Cookie") || "";

            const token = readSessionToken(
                cookieHeader,
                env
            );

            if (!token) {
                return jsonResponse(401, {
                    message: "Not authenticated",
                });
            }

            const upstream = await upstreamJson(
                `${baseUrl}${route}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "application/json",
                    },
                }
            );

            if (upstream.status === 401) {
                return jsonResponse(
                    401,
                    {
                        message: "Session expired",
                    },
                    {
                        "Set-Cookie":
                            clearSessionCookie(env),
                    }
                );
            }

            return jsonResponse(
                upstream.status,
                upstream.data || {}
            );
        }

        /*
         * Unknown route
         */
        return jsonResponse(404, {
            message: "Route not found",
            route,
        });
    } catch (error) {
        console.error(
            "Cloudflare tempmail function error:",
            error
        );

        return jsonResponse(500, {
            message: "Internal server error",
        });
    }
}
