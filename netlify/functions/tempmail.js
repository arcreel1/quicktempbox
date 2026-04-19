const DEFAULT_BASE_URL = "https://api.mail.tm";

function getBaseUrl() {
    return (process.env.MAILTM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function parseCookies(cookieHeader = "") {
    return cookieHeader
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
            const [key, ...rest] = part.split("=");
            acc[key] = decodeURIComponent(rest.join("="));
            return acc;
        }, {});
}

function getRoutePath(rawPath = "") {
    const apiPrefix = "/api/tempmail";
    const fnPrefix = "/.netlify/functions/tempmail";

    if (rawPath.startsWith(apiPrefix)) {
        return rawPath.slice(apiPrefix.length) || "/";
    }

    if (rawPath.startsWith(fnPrefix)) {
        return rawPath.slice(fnPrefix.length) || "/";
    }

    return "/";
}

function jsonResponse(statusCode, payload, headers = {}) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers,
        },
        body: JSON.stringify(payload),
    };
}

function buildSessionCookie(token) {
    const name = process.env.TM_SESSION_COOKIE_NAME || "tm_session";
    const maxAge = Number(process.env.TM_SESSION_MAX_AGE || 3600);
    return `${name}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
    const name = process.env.TM_SESSION_COOKIE_NAME || "tm_session";
    return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readSessionToken(cookieHeader) {
    const name = process.env.TM_SESSION_COOKIE_NAME || "tm_session";
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
        data = { message: text || "Unexpected upstream response" };
    }

    return { ok: res.ok, status: res.status, data };
}

exports.handler = async (event) => {
    try {
        const method = event.httpMethod;
        const route = getRoutePath(event.path);
        const baseUrl = getBaseUrl();

        if (method === "OPTIONS") {
            return {
                statusCode: 204,
                headers: {
                    Allow: "GET, POST, OPTIONS",
                },
            };
        }

        if (method === "GET" && route === "/domains") {
            const upstream = await upstreamJson(`${baseUrl}/domains`);
            return jsonResponse(upstream.status, upstream.data || {});
        }

        if (method === "POST" && route === "/accounts") {
            const payload = event.body ? JSON.parse(event.body) : {};
            const upstream = await upstreamJson(`${baseUrl}/accounts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            return jsonResponse(upstream.status, upstream.data || {});
        }

        if (method === "POST" && route === "/session") {
            const payload = event.body ? JSON.parse(event.body) : {};
            const upstream = await upstreamJson(`${baseUrl}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!upstream.ok || !upstream.data || !upstream.data.token) {
                return jsonResponse(upstream.status, upstream.data || { message: "Failed to create session" });
            }

            return jsonResponse(
                200,
                { ok: true },
                {
                    "Set-Cookie": buildSessionCookie(upstream.data.token),
                }
            );
        }

        if (method === "POST" && route === "/logout") {
            return jsonResponse(
                200,
                { ok: true },
                {
                    "Set-Cookie": clearSessionCookie(),
                }
            );
        }

        if (method === "GET" && (route === "/messages" || route.startsWith("/messages/"))) {
            const token = readSessionToken(event.headers.cookie || "");

            if (!token) {
                return jsonResponse(401, { message: "Not authenticated" });
            }

            const upstreamPath = route === "/messages" ? "/messages" : route;
            const upstream = await upstreamJson(`${baseUrl}${upstreamPath}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (upstream.status === 401) {
                return jsonResponse(
                    401,
                    { message: "Session expired" },
                    {
                        "Set-Cookie": clearSessionCookie(),
                    }
                );
            }

            return jsonResponse(upstream.status, upstream.data || {});
        }

        return jsonResponse(404, { message: "Route not found" });
    } catch (error) {
        console.error("tempmail function error", error);
        return jsonResponse(500, { message: "Internal server error" });
    }
};
