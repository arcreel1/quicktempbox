const DOMAIN = "outlook.dpdns.org";

function jsonResponse(status, data, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers,
        },
    });
}

function getRoute(request) {
    const url = new URL(request.url);
    const prefix = "/api/tempmail";

    if (url.pathname.startsWith(prefix)) {
        return url.pathname.slice(prefix.length) || "/";
    }

    return "/";
}

function randomUsername() {
    return Math.random()
        .toString(36)
        .substring(2, 10)
        .toLowerCase();
}

function getCookie(request, name) {
    const cookie = request.headers.get("Cookie") || "";

    const match = cookie
        .split(";")
        .map(v => v.trim())
        .find(v => v.startsWith(`${name}=`));

    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function sessionCookie(address) {
    return `tm_email=${encodeURIComponent(address)}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie() {
    return "tm_email=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

export async function onRequest(context) {
    const { request, env } = context;

    try {
        const method = request.method;
        const route = getRoute(request);

        /*
         * GET /domains
         */
        if (method === "GET" && route === "/domains") {
            return jsonResponse(200, {
                "@type": "Domain",
                domain: DOMAIN,
                isActive: true,
            });
        }

        /*
         * POST /accounts
         *
         * 前端传 address/password。
         * 我们不再调用 Mail.tm，
         * 而是直接把邮箱保存到 D1。
         */
        if (method === "POST" && route === "/accounts") {
            const payload = await request.json().catch(() => ({}));

            const address = String(payload.address || "")
                .trim()
                .toLowerCase();

            if (!address.endsWith(`@${DOMAIN}`)) {
                return jsonResponse(400, {
                    message: "Invalid email domain",
                });
            }

            const existing = await env.DB
                .prepare(`
                    SELECT address
                    FROM mailboxes
                    WHERE lower(address) = ?
                    LIMIT 1
                `)
                .bind(address)
                .first();

            if (existing) {
                return jsonResponse(409, {
                    message: "Mailbox already exists",
                });
            }

            await env.DB
                .prepare(`
                    INSERT INTO mailboxes
                    (address, created_at)
                    VALUES (?, ?)
                `)
                .bind(address, Date.now())
                .run();

            return jsonResponse(201, {
                address,
            });
        }

        /*
         * POST /session
         *
         * 现在不需要 Mail.tm token。
         * 用 HttpOnly cookie 保存当前邮箱。
         */
        if (method === "POST" && route === "/session") {
            const payload = await request.json().catch(() => ({}));

            const address = String(payload.address || "")
                .trim()
                .toLowerCase();

            if (!address.endsWith(`@${DOMAIN}`)) {
                return jsonResponse(400, {
                    message: "Invalid email",
                });
            }

            const mailbox = await env.DB
                .prepare(`
                    SELECT address
                    FROM mailboxes
                    WHERE lower(address) = ?
                    LIMIT 1
                `)
                .bind(address)
                .first();

            if (!mailbox) {
                return jsonResponse(401, {
                    message: "Mailbox does not exist",
                });
            }

            return jsonResponse(
                200,
                { ok: true },
                {
                    "Set-Cookie": sessionCookie(address),
                }
            );
        }

        /*
         * GET /messages
         */
        if (method === "GET" && route === "/messages") {
            const address = getCookie(request, "tm_email");

            if (!address) {
                return jsonResponse(401, {
                    message: "Not authenticated",
                });
            }

            const mailbox = await env.DB
                .prepare(`
                    SELECT address
                    FROM mailboxes
                    WHERE lower(address) = ?
                    LIMIT 1
                `)
                .bind(address.toLowerCase())
                .first();

            if (!mailbox) {
                return jsonResponse(401, {
                    message: "Mailbox does not exist",
                });
            }

            const result = await env.DB
                .prepare(`
                    SELECT
                        id,
                        message_id,
                        sender,
                        recipient,
                        subject,
                        body_text,
                        received_at
                    FROM messages
                    WHERE lower(mailbox_address) = ?
                    ORDER BY received_at DESC
                    LIMIT 100
                `)
                .bind(address.toLowerCase())
                .all();

            const messages = (result.results || []).map(row => ({
                id: String(row.id),
                from: {
                    address: row.sender || "",
                },
                to: [
                    {
                        address: row.recipient || "",
                    }
                ],
                subject: row.subject || "",
                intro: String(row.body_text || "")
                    .replace(/\s+/g, " ")
                    .substring(0, 180),
                createdAt: new Date(row.received_at).toISOString(),
                seen: false,
                hasAttachments: false,
            }));

            return jsonResponse(200, {
                "hydra:member": messages,
                "hydra:totalItems": messages.length,
            });
        }

        /*
         * GET /messages/:id
         */
        if (
            method === "GET" &&
            route.startsWith("/messages/")
        ) {
            const id = route.substring("/messages/".length);

            const address = getCookie(request, "tm_email");

            if (!address) {
                return jsonResponse(401, {
                    message: "Not authenticated",
                });
            }

            const row = await env.DB
                .prepare(`
                    SELECT
                        id,
                        sender,
                        recipient,
                        subject,
                        body_text,
                        body_html,
                        received_at
                    FROM messages
                    WHERE id = ?
                    AND lower(mailbox_address) = ?
                    LIMIT 1
                `)
                .bind(
                    Number(id),
                    address.toLowerCase()
                )
                .first();

            if (!row) {
                return jsonResponse(404, {
                    message: "Message not found",
                });
            }

            return jsonResponse(200, {
                id: String(row.id),
                from: {
                    address: row.sender || "",
                },
                to: [
                    {
                        address: row.recipient || "",
                    }
                ],
                subject: row.subject || "",
                text: row.body_text || "",
                html: row.body_html || "",
                createdAt: new Date(row.received_at).toISOString(),
            });
        }

        /*
         * POST /logout
         */
        if (method === "POST" && route === "/logout") {
            return jsonResponse(
                200,
                { ok: true },
                {
                    "Set-Cookie": clearCookie(),
                }
            );
        }

        return jsonResponse(404, {
            message: "Route not found",
        });

    } catch (error) {
        console.error("QuickTempBox API error:", error);

        return jsonResponse(500, {
            message: "Internal server error",
        });
    }
}
