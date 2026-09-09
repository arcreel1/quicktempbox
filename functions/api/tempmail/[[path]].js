const DEFAULT_DOMAIN = "outlook.dpdns.org";
const COOKIE_NAME = "tm_session";
const SESSION_MAX_AGE = 86400;

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...extraHeaders,
        },
    });
}

function parseCookies(cookieHeader = "") {
    const cookies = {};

    for (const part of cookieHeader.split(";")) {
        const index = part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        if (!key) {
            continue;
        }

        try {
            cookies[key] = decodeURIComponent(value);
        } catch {
            cookies[key] = value;
        }
    }

    return cookies;
}

function getSession(request) {
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = parseCookies(cookieHeader);

    return cookies[COOKIE_NAME] || null;
}

function sessionCookie(value) {
    return [
        `${COOKIE_NAME}=${encodeURIComponent(value)}`,
        "Path=/",
        `Max-Age=${SESSION_MAX_AGE}`,
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
    ].join("; ");
}

function clearCookie() {
    return [
        `${COOKIE_NAME}=`,
        "Path=/",
        "Max-Age=0",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
    ].join("; ");
}

function randomString(length = 8) {
    const chars =
        "abcdefghijklmnopqrstuvwxyz0123456789";

    const array = new Uint8Array(length);

    crypto.getRandomValues(array);

    let result = "";

    for (let i = 0; i < length; i++) {
        result += chars[array[i] % chars.length];
    }

    return result;
}

function createEmail() {
    return `${randomString(8)}@${DEFAULT_DOMAIN}`;
}

function now() {
    return new Date().toISOString();
}

function getDB(env) {
    return env.DB || env.D1 || env.quicktempbox;
}

async function ensureTables(db) {
    if (!db) {
        throw new Error(
            "D1 binding not found. Please bind your D1 database as DB."
        );
    }

    await db
        .prepare(
            `
            CREATE TABLE IF NOT EXISTS mailboxes (
                id TEXT PRIMARY KEY,
                address TEXT NOT NULL UNIQUE,
                local_part TEXT NOT NULL,
                domain TEXT NOT NULL,
                password TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT,
                active INTEGER NOT NULL DEFAULT 1
            )
            `
        )
        .run();

    await db
        .prepare(
            `
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                recipients TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                intro TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                html TEXT NOT NULL DEFAULT '',
                received_at TEXT NOT NULL,
                seen INTEGER NOT NULL DEFAULT 0,
                has_attachments INTEGER NOT NULL DEFAULT 0
            )
            `
        )
        .run();

    await db
        .prepare(
            `
            CREATE INDEX IF NOT EXISTS idx_messages_mailbox
            ON messages(mailbox_id, received_at DESC)
            `
        )
        .run();
}

function makeHydra(messages) {
    return {
        "hydra:member": messages,
        "hydra:totalItems": messages.length,
    };
}

function safeJsonParse(value, fallback = []) {
    try {
        const parsed = JSON.parse(value);

        return parsed;
    } catch {
        return fallback;
    }
}

function messageListItem(row) {
    const recipients = safeJsonParse(
        row.recipients || "[]",
        []
    );

    return {
        id: row.id,

        from: {
            address: row.sender || "unknown",
        },

        to: Array.isArray(recipients)
            ? recipients.map((address) => ({
                address,
            }))
            : [],

        subject: row.subject || "",
        intro: row.intro || "",
        createdAt: row.received_at,
        seen: Boolean(row.seen),
        hasAttachments: Boolean(
            row.has_attachments
        ),
    };
}

function decodeBase64Utf8(value) {
    try {
        const cleaned = String(value || "")
            .replace(/\s/g, "");

        const binary = atob(cleaned);

        const bytes = new Uint8Array(
            binary.length
        );

        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return new TextDecoder("utf-8").decode(
            bytes
        );
    } catch {
        return value || "";
    }
}

function decodeQuotedPrintable(value) {
    return String(value || "")
        .replace(/=\r?\n/g, "")
        .replace(
            /=([0-9A-Fa-f]{2})/g,
            (_, hex) =>
                String.fromCharCode(
                    parseInt(hex, 16)
                )
        );
}

function decodeMimeWord(value) {
    if (!value) {
        return "";
    }

    return value.replace(
        /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g,
        (
            _match,
            charset,
            encoding,
            content
        ) => {
            try {
                if (
                    encoding.toLowerCase() === "b"
                ) {
                    const binary =
                        atob(content);

                    const bytes =
                        new Uint8Array(
                            binary.length
                        );

                    for (
                        let i = 0;
                        i < binary.length;
                        i++
                    ) {
                        bytes[i] =
                            binary.charCodeAt(i);
                    }

                    const decoderCharset =
                        charset
                            .toLowerCase()
                            .includes("gb")
                            ? "gb18030"
                            : "utf-8";

                    return new TextDecoder(
                        decoderCharset
                    ).decode(bytes);
                }

                return content
                    .replace(/_/g, " ")
                    .replace(
                        /=([0-9A-Fa-f]{2})/g,
                        (_, hex) =>
                            String.fromCharCode(
                                parseInt(
                                    hex,
                                    16
                                )
                            )
                    );
            } catch {
                return content;
            }
        }
    );
}

function getHeader(raw, name) {
    const regex = new RegExp(
        `^${name}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)$`,
        "im"
    );

    const match = String(raw || "").match(
        regex
    );

    if (!match) {
        return "";
    }

    return match[1]
        .replace(/\r?\n[ \t]+/g, " ")
        .trim();
}

function extractMimeBody(raw) {
    const input = String(raw || "");

    const separatorMatch =
        input.match(/\r?\n\r?\n/);

    if (!separatorMatch) {
        return {
            headers: input,
            body: "",
        };
    }

    const headerEnd =
        separatorMatch.index;

    return {
        headers: input.slice(
            0,
            headerEnd
        ),

        body: input.slice(
            headerEnd +
                separatorMatch[0].length
        ),
    };
}

function decodeMimePart(
    body,
    transferEncoding
) {
    if (
        /base64/i.test(
            transferEncoding || ""
        )
    ) {
        return decodeBase64Utf8(body);
    }

    if (
        /quoted-printable/i.test(
            transferEncoding || ""
        )
    ) {
        return decodeQuotedPrintable(body);
    }

    return body || "";
}

function htmlToText(html) {
    return String(html || "")
        .replace(
            /<style[\s\S]*?<\/style>/gi,
            ""
        )
        .replace(
            /<script[\s\S]*?<\/script>/gi,
            ""
        )
        .replace(
            /<br\s*\/?>/gi,
            "\n"
        )
        .replace(
            /<\/p>/gi,
            "\n"
        )
        .replace(
            /<[^>]+>/g,
            " "
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

function parseEmail(rawEmail) {
    const {
        headers,
        body,
    } = extractMimeBody(rawEmail);

    const subject =
        decodeMimeWord(
            getHeader(
                headers,
                "Subject"
            )
        );

    const contentType =
        getHeader(
            headers,
            "Content-Type"
        );

    const transferEncoding =
        getHeader(
            headers,
            "Content-Transfer-Encoding"
        );

    let decodedBody =
        decodeMimePart(
            body,
            transferEncoding
        );

    let text = "";
    let html = "";

    if (
        /multipart\/alternative/i.test(
            contentType
        ) ||
        /multipart\/mixed/i.test(
            contentType
        )
    ) {
        const boundaryMatch =
            contentType.match(
                /boundary="?([^";]+)"?/i
            );

        if (boundaryMatch) {
            const boundary =
                boundaryMatch[1];

            const parts =
                decodedBody.split(
                    `--${boundary}`
                );

            for (
                const part of parts
            ) {
                const {
                    headers:
                        partHeaders,
                    body:
                        partBody,
                } =
                    extractMimeBody(
                        part
                    );

                if (
                    !partHeaders ||
                    !partBody
                ) {
                    continue;
                }

                const partType =
                    getHeader(
                        partHeaders,
                        "Content-Type"
                    );

                const partEncoding =
                    getHeader(
                        partHeaders,
                        "Content-Transfer-Encoding"
                    );

                const decodedPart =
                    decodeMimePart(
                        partBody,
                        partEncoding
                    ).trim();

                if (
                    /text\/plain/i.test(
                        partType
                    )
                ) {
                    text =
                        decodedPart;
                }

                if (
                    /text\/html/i.test(
                        partType
                    )
                ) {
                    html =
                        decodedPart;
                }
            }
        }
    } else if (
        /text\/html/i.test(
            contentType
        )
    ) {
        html =
            decodedBody.trim();

        text =
            htmlToText(html);
    } else {
        text =
            decodedBody.trim();
    }

    if (!text && html) {
        text =
            htmlToText(html);
    }

    return {
        subject:
            subject || "",

        text:
            text || "",

        html:
            html || "",

        intro:
            (text || "")
                .replace(
                    /\s+/g,
                    " "
                )
                .trim()
                .slice(0, 200),
    };
}

async function getMailbox(
    db,
    address
) {
    return await db
        .prepare(
            `
            SELECT *
            FROM mailboxes
            WHERE lower(address) = lower(?)
              AND active = 1
            LIMIT 1
            `
        )
        .bind(address)
        .first();
}

async function getMailboxById(
    db,
    id
) {
    return await db
        .prepare(
            `
            SELECT *
            FROM mailboxes
            WHERE id = ?
              AND active = 1
            LIMIT 1
            `
        )
        .bind(id)
        .first();
}

async function createMailbox(
    db,
    address,
    password
) {
    const id =
        crypto.randomUUID();

    const parts =
        address.split("@");

    const localPart =
        parts[0] || "";

    const domain =
        parts[1] || DEFAULT_DOMAIN;

    const createdAt =
        now();

    const expiresAt =
        new Date(
            Date.now() +
                24 * 60 * 60 * 1000
        ).toISOString();

    await db
        .prepare(
            `
            INSERT INTO mailboxes
            (
                id,
                address,
                local_part,
                domain,
                password,
                created_at,
                expires_at,
                active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `
        )
        .bind(
            id,
            address,
            localPart,
            domain,
            password,
            createdAt,
            expiresAt
        )
        .run();

    return {
        id,
        address,
        password,
    };
}

async function handleDomains() {
    return json({
        "@context": "/contexts/Domain",
        "@id": "/domains",
        "@type": "hydra:Collection",

        "hydra:totalItems": 1,

        "hydra:member": [
            {
                "@id":
                    `/domains/${DEFAULT_DOMAIN}`,

                "@type": "Domain",

                id:
                    DEFAULT_DOMAIN,

                domain:
                    DEFAULT_DOMAIN,

                isActive: true,

                isPrivate: false,
            },
        ],
    });
}

async function handleCreateAccount(
    request,
    env
) {
    const db =
        getDB(env);

    await ensureTables(db);

    let payload;

    try {
        payload =
            await request.json();
    } catch {
        return json(
            {
                message:
                    "Invalid JSON body",
            },
            400
        );
    }

    const address =
        String(
            payload?.address || ""
        )
            .trim()
            .toLowerCase();

    const password =
        String(
            payload?.password || ""
        );

    if (
        !address ||
        !password
    ) {
        return json(
            {
                message:
                    "address and password are required",
            },
            400
        );
    }

    const expectedSuffix =
        `@${DEFAULT_DOMAIN}`;

    if (
        !address.endsWith(
            expectedSuffix
        )
    ) {
        return json(
            {
                message:
                    `Only ${DEFAULT_DOMAIN} is supported`,
            },
            422
        );
    }

    const localPart =
        address.slice(
            0,
            -expectedSuffix.length
        );

    if (
        !localPart ||
        localPart.includes("@") ||
        localPart.length > 64
    ) {
        return json(
            {
                message:
                    "Invalid email address",
            },
            422
        );
    }

    const existing =
        await db
            .prepare(
                `
                SELECT id
                FROM mailboxes
                WHERE lower(address) = lower(?)
                LIMIT 1
                `
            )
            .bind(address)
            .first();

    if (existing) {
        return json(
            {
                message:
                    "Email address already exists",
            },
            409
        );
    }

    let mailbox;

    try {
        mailbox =
            await createMailbox(
                db,
                address,
                password
            );
    } catch (error) {
        console.error(
            "createMailbox error:",
            error
        );

        return json(
            {
                message:
                    "Failed to create mailbox",
                error:
                    error?.message ||
                    String(error),
            },
            500
        );
    }

    return json(
        {
            "@type":
                "Account",

            id:
                mailbox.id,

            address:
                mailbox.address,
        },
        201
    );
}

async function handleSession(
    request,
    env
) {
    const db =
        getDB(env);

    await ensureTables(db);

    let payload;

    try {
        payload =
            await request.json();
    } catch {
        return json(
            {
                message:
                    "Invalid JSON body",
            },
            400
        );
    }

    const address =
        String(
            payload?.address || ""
        )
            .trim()
            .toLowerCase();

    const password =
        String(
            payload?.password || ""
        );

    const mailbox =
        await db
            .prepare(
                `
                SELECT *
                FROM mailboxes
                WHERE lower(address) = lower(?)
                  AND active = 1
                LIMIT 1
                `
            )
            .bind(address)
            .first();

    if (
        !mailbox ||
        mailbox.password !== password
    ) {
        return json(
            {
                message:
                    "Invalid credentials",
            },
            401
        );
    }

    return json(
        {
            ok: true,
        },
        200,
        {
            "Set-Cookie":
                sessionCookie(
                    mailbox.id
                ),
        }
    );
}

async function handleMessages(
    request,
    env,
    route
) {
    const db =
        getDB(env);

    await ensureTables(db);

    const sessionId =
        getSession(request);

    if (!sessionId) {
        return json(
            {
                message:
                    "Not authenticated",
            },
            401
        );
    }

    const mailbox =
        await getMailboxById(
            db,
            sessionId
        );

    if (!mailbox) {
        return json(
            {
                message:
                    "Session expired",
            },
            401,
            {
                "Set-Cookie":
                    clearCookie(),
            }
        );
    }

    if (
        route === "/messages"
    ) {
        const result =
            await db
                .prepare(
                    `
                    SELECT *
                    FROM messages
                    WHERE mailbox_id = ?
                    ORDER BY received_at DESC
                    LIMIT 100
                    `
                )
                .bind(
                    mailbox.id
                )
                .all();

        const messages =
            (
                result.results ||
                []
            ).map(
                messageListItem
            );

        return json(
            makeHydra(
                messages
            )
        );
    }

    const prefix =
        "/messages/";

    if (
        route.startsWith(
            prefix
        )
    ) {
        const id =
            decodeURIComponent(
                route.slice(
                    prefix.length
                )
            );

        if (!id) {
            return json(
                {
                    message:
                        "Message ID is required",
                },
                400
            );
        }

        const message =
            await db
                .prepare(
                    `
                    SELECT *
                    FROM messages
                    WHERE id = ?
                      AND mailbox_id = ?
                    LIMIT 1
                    `
                )
                .bind(
                    id,
                    mailbox.id
                )
                .first();

        if (!message) {
            return json(
                {
                    message:
                        "Message not found",
                },
                404
            );
        }

        await db
            .prepare(
                `
                UPDATE messages
                SET seen = 1
                WHERE id = ?
                  AND mailbox_id = ?
                `
            )
            .bind(
                id,
                mailbox.id
            )
            .run();

        const recipients =
            safeJsonParse(
                message.recipients ||
                    "[]",
                []
            );

        return json({
            id:
                message.id,

            from: {
                address:
                    message.sender ||
                    "unknown",
            },

            to:
                Array.isArray(
                    recipients
                )
                    ? recipients.map(
                        (address) => ({
                            address,
                        })
                    )
                    : [],

            subject:
                message.subject ||
                "",

            intro:
                message.intro ||
                "",

            text:
                message.text ||
                "",

            html:
                message.html ||
                "",

            createdAt:
                message.received_at,

            seen:
                true,

            hasAttachments:
                Boolean(
                    message.has_attachments
                ),
        });
    }

    return json(
        {
            message:
                "Route not found",
        },
        404
    );
}

async function handleLogout() {
    return json(
        {
            ok: true,
        },
        200,
        {
            "Set-Cookie":
                clearCookie(),
        }
    );
}

async function handleReceive(
    request,
    env
) {
    const db =
        getDB(env);

    await ensureTables(db);

    const from =
        request.headers.get(
            "X-Email-From"
        ) || "";

    const to =
        request.headers.get(
            "X-Email-To"
        ) || "";

    const raw =
        await request.text();

    const recipients =
        to
            .split(",")
            .map(
                (x) =>
                    x.trim().toLowerCase()
            )
            .filter(Boolean);

    if (
        recipients.length === 0
    ) {
        return json(
            {
                message:
                    "Missing recipient",
            },
            400
        );
    }

    const parsed =
        parseEmail(raw);

    let inserted = 0;

    for (
        const recipient of recipients
    ) {
        const mailbox =
            await getMailbox(
                db,
                recipient
            );

        if (!mailbox) {
            continue;
        }

        const id =
            crypto.randomUUID();

        await db
            .prepare(
                `
                INSERT INTO messages
                (
                    id,
                    mailbox_id,
                    sender,
                    recipients,
                    subject,
                    intro,
                    text,
                    html,
                    received_at,
                    seen,
                    has_attachments
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                `
            )
            .bind(
                id,
                mailbox.id,
                from ||
                    "unknown",
                JSON.stringify(
                    recipients
                ),
                parsed.subject,
                parsed.intro,
                parsed.text,
                parsed.html,
                now()
            )
            .run();

        inserted++;
    }

    return json({
        ok: true,
        inserted,
    });
}

function getRoute(params) {
    const path =
        params?.path;

    if (
        Array.isArray(path)
    ) {
        return (
            "/" +
            path
                .filter(Boolean)
                .join("/")
        );
    }

    if (
        typeof path ===
        "string"
    ) {
        return "/" + path;
    }

    return "/";
}

export async function onRequest(
    context
) {
    const {
        request,
        env,
        params,
    } = context;

    const method =
        request.method;

    const route =
        getRoute(params);

    try {
        if (
            method === "OPTIONS"
        ) {
            return new Response(
                null,
                {
                    status: 204,

                    headers: {
                        Allow:
                            "GET, POST, OPTIONS",
                    },
                }
            );
        }

        if (
            method === "GET" &&
            route === "/domains"
        ) {
            return handleDomains();
        }

        if (
            method === "POST" &&
            route === "/accounts"
        ) {
            return handleCreateAccount(
                request,
                env
            );
        }

        if (
            method === "POST" &&
            route === "/session"
        ) {
            return handleSession(
                request,
                env
            );
        }

        if (
            method === "POST" &&
            route === "/logout"
        ) {
            return handleLogout();
        }

        if (
            method === "GET" &&
            (
                route ===
                    "/messages" ||
                route.startsWith(
                    "/messages/"
                )
            )
        ) {
            return handleMessages(
                request,
                env,
                route
            );
        }

        if (
            method === "POST" &&
            route === "/receive"
        ) {
            return handleReceive(
                request,
                env
            );
        }

        return json(
            {
                message:
                    "Route not found",

                route,
            },
            404
        );
    } catch (error) {
        console.error(
            "tempmail error:",
            error
        );

        return json(
            {
                message:
                    "Internal server error",

                error:
                    error?.message ||
                    String(error),
            },
            500
        );
    }
}
