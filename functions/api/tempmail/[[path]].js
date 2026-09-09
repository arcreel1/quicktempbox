const DEFAULT_BASE_URL = "https://api.mail.tm";

function getBaseUrl() {
    return (
        process.env.MAILTM_BASE_URL ||
        DEFAULT_BASE_URL
    ).replace(/\/$/, "");
}

function parseCookies(cookieHeader = "") {
    return cookieHeader
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const index = part.indexOf("=");

            if (index === -1) {
                return cookies;
            }

            const key = part
                .slice(0, index)
                .trim();

            const value = part
                .slice(index + 1)
                .trim();

            try {
                cookies[key] =
                    decodeURIComponent(value);
            } catch {
                cookies[key] = value;
            }

            return cookies;
        }, {});
}

function getRoutePath(rawPath = "") {
    const apiPrefix = "/api/tempmail";
    const functionPrefix =
        "/.netlify/functions/tempmail";

    if (rawPath.startsWith(apiPrefix)) {
        return (
            rawPath.slice(apiPrefix.length) ||
            "/"
        );
    }

    if (rawPath.startsWith(functionPrefix)) {
        return (
            rawPath.slice(functionPrefix.length) ||
            "/"
        );
    }

    return "/";
}

function jsonResponse(
    statusCode,
    payload,
    headers = {}
) {
    return {
        status: statusCode,
        headers: {
            "Content-Type":
                "application/json; charset=utf-8",

            "Cache-Control":
                "no-store, no-cache, must-revalidate",

            ...headers,
        },

        body: JSON.stringify(
            payload ?? {}
        ),
    };
}

function buildSessionCookie(token) {
    const name =
        process.env.TM_SESSION_COOKIE_NAME ||
        "tm_session";

    const maxAge = Number(
        process.env.TM_SESSION_MAX_AGE ||
        3600
    );

    return [
        `${name}=${encodeURIComponent(token)}`,
        "Path=/",
        `Max-Age=${maxAge}`,
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
    ].join("; ");
}

function clearSessionCookie() {
    const name =
        process.env.TM_SESSION_COOKIE_NAME ||
        "tm_session";

    return [
        `${name}=`,
        "Path=/",
        "Max-Age=0",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
    ].join("; ");
}

function readSessionToken(
    cookieHeader = ""
) {
    const name =
        process.env.TM_SESSION_COOKIE_NAME ||
        "tm_session";

    const cookies =
        parseCookies(cookieHeader);

    return cookies[name] || null;
}

async function upstreamJson(
    url,
    options = {}
) {
    const response = await fetch(
        url,
        options
    );

    const text =
        await response.text();

    let data = null;

    try {
        data = text
            ? JSON.parse(text)
            : null;
    } catch {
        data = {
            message:
                text ||
                "Unexpected upstream response",
        };
    }

    return {
        ok: response.ok,
        status: response.status,
        data,
    };
}

function getCookieHeader(event) {
    return (
        event.headers?.cookie ||
        event.headers?.Cookie ||
        ""
    );
}

function getRequestBody(event) {
    if (!event.body) {
        return {};
    }

    try {
        return JSON.parse(event.body);
    } catch {
        return {};
    }
}

export async function onRequest(context) {
    const request =
        context.request;

    const env =
        context.env || {};

    const url =
        new URL(request.url);

    const method =
        request.method.toUpperCase();

    const route =
        getRoutePath(url.pathname);

    const baseUrl =
        (
            env.MAILTM_BASE_URL ||
            DEFAULT_BASE_URL
        ).replace(/\/$/, "");

    /*
     * CORS / preflight.
     */
    if (method === "OPTIONS") {
        return new Response(
            null,
            {
                status: 204,
                headers: {
                    "Allow":
                        "GET, POST, OPTIONS",
                },
            }
        );
    }

    try {
        /*
         * GET /domains
         *
         * This is only used as an API test.
         * The frontend uses CUSTOM_DOMAIN directly.
         */
        if (
            method === "GET" &&
            route === "/domains"
        ) {
            const upstream =
                await upstreamJson(
                    `${baseUrl}/domains`
                );

            return new Response(
                JSON.stringify(
                    upstream.data || {}
                ),
                {
                    status:
                        upstream.status,
                    headers: {
                        "Content-Type":
                            "application/json; charset=utf-8",
                        "Cache-Control":
                            "no-store",
                    },
                }
            );
        }

        /*
         * POST /accounts
         */
        if (
            method === "POST" &&
            route === "/accounts"
        ) {
            const payload =
                getRequestBody({
                    body:
                        await request
                            .clone()
                            .text(),
                });

            const upstream =
                await upstreamJson(
                    `${baseUrl}/accounts`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                        },
                        body:
                            JSON.stringify(
                                payload
                            ),
                    }
                );

            return new Response(
                JSON.stringify(
                    upstream.data || {}
                ),
                {
                    status:
                        upstream.status,
                    headers: {
                        "Content-Type":
                            "application/json; charset=utf-8",
                        "Cache-Control":
                            "no-store",
                    },
                }
            );
        }

        /*
         * POST /session
         *
         * Login to Mail.tm and store
         * the returned token in an
         * HttpOnly cookie.
         */
        if (
            method === "POST" &&
            route === "/session"
        ) {
            const text =
                await request.text();

            let payload = {};

            try {
                payload = text
                    ? JSON.parse(text)
                    : {};
            } catch {
                payload = {};
            }

            const upstream =
                await upstreamJson(
                    `${baseUrl}/token`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                        },
                        body:
                            JSON.stringify(
                                payload
                            ),
                    }
                );

            if (
                !upstream.ok ||
                !upstream.data ||
                !upstream.data.token
            ) {
                return new Response(
                    JSON.stringify(
                        upstream.data || {
                            message:
                                "Failed to create session",
                        }
                    ),
                    {
                        status:
                            upstream.status ||
                            500,
                        headers: {
                            "Content-Type":
                                "application/json; charset=utf-8",
                            "Cache-Control":
                                "no-store",
                        },
                    }
                );
            }

            return new Response(
                JSON.stringify({
                    ok: true,
                }),
                {
                    status: 200,
                    headers: {
                        "Content-Type":
                            "application/json; charset=utf-8",

                        "Cache-Control":
                            "no-store",

                        "Set-Cookie":
                            buildSessionCookie(
                                upstream.data.token
                            ),
                    },
                }
            );
        }

        /*
         * POST /logout
         */
        if (
            method === "POST" &&
            route === "/logout"
        ) {
            return new Response(
                JSON.stringify({
                    ok: true,
                }),
                {
                    status: 200,
                    headers: {
                        "Content-Type":
                            "application/json; charset=utf-8",

                        "Cache-Control":
                            "no-store",

                        "Set-Cookie":
                            clearSessionCookie(),
                    },
                }
            );
        }

        /*
         * GET /messages
         * GET /messages/:id
         */
        if (
            method === "GET" &&
            (
                route === "/messages" ||
                route.startsWith(
                    "/messages/"
                )
            )
        ) {
            const cookieHeader =
                getCookieHeader(
                    context
                );

            const token =
                readSessionToken(
                    cookieHeader
                );

            if (!token) {
                return new Response(
                    JSON.stringify({
                        message:
                            "Not authenticated",
                    }),
                    {
                        status: 401,
                        headers: {
                            "Content-Type":
                                "application/json; charset=utf-8",
                            "Cache-Control":
                                "no-store",
                        },
                    }
                );
            }

            /*
             * IMPORTANT:
             *
             * Keep the exact message path,
             * including /messages/4.
             */
            const upstream =
                await upstreamJson(
                    `${baseUrl}${route}`,
                    {
                        method: "GET",
                        headers: {
                            "Authorization":
                                `Bearer ${token}`,
                            "Accept":
                                "application/json",
                        },
                    }
                );

            /*
             * Mail.tm session expired.
             */
            if (
                upstream.status === 401
            ) {
                return new Response(
                    JSON.stringify({
                        message:
                            "Session expired",
                    }),
                    {
                        status: 401,
                        headers: {
                            "Content-Type":
                                "application/json; charset=utf-8",

                            "Cache-Control":
                                "no-store",

                            "Set-Cookie":
                                clearSessionCookie(),
                        },
                    }
                );
            }

            /*
             * Return the COMPLETE Mail.tm
             * response unchanged.
             *
             * This is important because
             * /messages/:id can contain
             * text/html/text fields.
             */
            return new Response(
                JSON.stringify(
                    upstream.data || {}
                ),
                {
                    status:
                        upstream.status,

                    headers: {
                        "Content-Type":
                            "application/json; charset=utf-8",

                        "Cache-Control":
                            "no-store",
                    },
                }
            );
        }

        return new Response(
            JSON.stringify({
                message:
                    "Route not found",
                route,
                method,
            }),
            {
                status: 404,
                headers: {
                    "Content-Type":
                        "application/json; charset=utf-8",
                },
            }
        );
    } catch (error) {
        console.error(
            "tempmail function error:",
            error
        );

        return new Response(
            JSON.stringify({
                message:
                    "Internal server error",
            }),
            {
                status: 500,
                headers: {
                    "Content-Type":
                        "application/json; charset=utf-8",
                },
            }
        );
    }
}
