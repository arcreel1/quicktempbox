const DEFAULT_DOMAIN = "outlook.dpdns.org";

const COOKIE_NAME = "tm_session";
const SESSION_MAX_AGE = 86400;

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    local_part TEXT NOT NULL,
    domain TEXT NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    active INTEGER NOT NULL DEFAULT 1
);

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
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox
ON messages(mailbox_id, received_at DESC);
`;

function json(data, status = 200, extraHeaders = {}) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
                ...extraHeaders,
            },
        }
    );
}

function errorResponse(message, status = 500, error = null) {
    const data = {
        ok: false,
        message,
    };

    if (error) {
        data.error =
            error?.message ||
            String(error);
    }

    return json(data, status);
}

function parseCookies(cookieHeader = "") {
    const cookies = {};

    for (const part of cookieHeader.split(";")) {
        const index = part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const key =
            part.slice(0, index).trim();

        const value =
            part.slice(index + 1).trim();

        if (!key) {
            continue;
        }

        try {
            cookies[key] =
                decodeURIComponent(value);
        } catch {
            cookies[key] = value;
        }
    }

    return cookies;
}

function getSession(request) {
    const cookieHeader =
        request.headers.get("Cookie") || "";

    const cookies =
        parseCookies(cookieHeader);

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

    let result = "";

    const array =
        new Uint8Array(length);

    crypto.getRandomValues(array);

    for (let i = 0; i < length; i++) {
        result +=
            chars[array[i] % chars.length];
    }

    return result;
}

function createEmail() {
    return (
        randomString(8) +
        "@" +
        DEFAULT_DOMAIN
    );
}

function now() {
    return new Date().toISOString();
}

/*
 * D1 binding detection.
 *
 * Your Cloudflare Pages binding should be:
 *
 * Variable name: DB
 * D1 database: quicktempbox
 */
function getDB(env) {
    if (!env) {
        throw new Error(
            "Cloudflare env object is missing."
        );
    }

    if (env.DB) {
        return env.DB;
    }

    if (env.D1) {
        return env.D1;
    }

    if (env.quicktempbox) {
        return env.quicktempbox;
    }

    throw new Error(
        "D1 binding not found. Cloudflare Pages -> Settings -> Functions -> Bindings -> D1 database -> Variable name must be DB -> Database must be quicktempbox."
    );
}

/*
 * Check that the D1 binding actually works.
 */
async function verifyDB(db) {
    if (!db) {
        throw new Error(
            "D1 database binding is empty."
        );
    }

    if (
        typeof db.prepare !== "function"
    ) {
        throw new Error(
            "The DB binding exists, but it is not a valid D1Database object."
        );
    }

    await db
        .prepare("SELECT 1 AS ok")
        .first();
}

/*
 * Automatically create tables.
 *
 * IMPORTANT:
 * This uses separate statements instead of sending
 * several SQL statements through one D1 prepare().
 */
async function ensureTables(db) {
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

function safeParseRecipients(value) {
    try {
        const parsed =
            JSON.parse(value || "[]");

        return Array.isArray(parsed)
            ? parsed
            : [];
    } catch {
        return [];
    }
}

function messageListItem(row) {
    return {
        id: row.id,

        from: {
            address:
                row.sender || "unknown",
        },

        to: safeParseRecipients(
            row.recipients
        ).map((address) => ({
            address,
        })),

        subject:
            row.subject || "",

        intro:
            row.intro || "",

        createdAt:
            row.received_at,

        seen:
            Boolean(row.seen),

        hasAttachments:
            Boolean(row.has_attachments),
    };
}

/*
 * Base64 UTF-8 decoder.
 */
function decodeBase64Utf8(value) {
    try {
        const cleaned =
            String(value || "")
                .replace(/\s/g, "");

        const binary =
            atob(cleaned);

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

        return new TextDecoder(
            "utf-8"
        ).decode(bytes);
    } catch {
        return value || "";
    }
}

/*
 * Quoted-printable decoder.
 */
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

/*
 * Decode MIME encoded words.
 *
 * Supports:
 * =?UTF-8?B?...?=
 * =?UTF-8?Q?...?=
 * =?GB2312?B?...?=
 * =?GBK?B?...?=
 */
function decodeMimeWord(value) {
    if (!value) {
        return "";
    }

    return String(value).replace(
        /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g,
        (
            _match,
            charset,
            encoding,
            content
        ) => {
            try {
                const normalizedCharset =
                    String(charset)
                        .toLowerCase();

                let decoderCharset =
                    "utf-8";

                if (
                    normalizedCharset.includes(
                        "gb"
                    )
                ) {
                    decoderCharset =
                        "gb18030";
                }

                if (
                    encoding.toLowerCase() ===
                    "b"
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

                    return new TextDecoder(
                        decoderCharset
                    ).decode(bytes);
                }

                const decoded =
                    content
                        .replace(
                            /_/g,
                            " "
                        )
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

                return decoded;
            } catch {
                return content;
            }
        }
    );
}

/*
 * Read a MIME header including folded lines.
 */
function getHeader(raw, name) {
    const escapedName =
        name.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );

    const regex =
        new RegExp(
            `^${escapedName}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)$`,
            "im"
        );

    const match =
        raw.match(regex);

    if (!match) {
        return "";
    }

    return match[1]
        .replace(
            /\r?\n[ \t]+/g,
            " "
        )
        .trim();
}

/*
 * Separate MIME headers and body.
 */
function extractMimeBody(raw) {
    const separator =
        raw.match(/\r?\n\r?\n/);

    if (!separator) {
        return {
            headers: raw,
            body: "",
        };
    }

    const index =
        separator.index;

    return {
        headers:
            raw.slice(0, index),

        body:
            raw.slice(
                index +
                    separator[0].length
            ),
    };
}

/*
 * Remove HTML to produce readable text.
 */
function htmlToText(html) {
    if (!html) {
        return "";
    }

    return String(html)
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
            /<\/div>/gi,
            "\n"
        )
        .replace(
            /<[^>]+>/g,
            " "
        )
        .replace(
            /&nbsp;/gi,
            " "
        )
        .replace(
            /&amp;/gi,
            "&"
        )
        .replace(
            /&lt;/gi,
            "<"
        )
        .replace(
            /&gt;/gi,
            ">"
        )
        .replace(
            /\r/g,
            ""
        )
        .replace(
            /[ \t]+\n/g,
            "\n"
        )
        .replace(
            /\n{3,}/g,
            "\n\n"
        )
        .trim();
}

/*
 * Decode one MIME part.
 */
function decodeMimePart(
    headers,
    body
) {
    const encoding =
        getHeader(
            headers,
            "Content-Transfer-Encoding"
        );

    let decoded =
        body || "";

    if (
        /base64/i.test(
            encoding
        )
    ) {
        decoded =
            decodeBase64Utf8(
                decoded
            );
    } else if (
        /quoted-printable/i.test(
            encoding
        )
    ) {
        decoded =
            decodeQuotedPrintable(
                decoded
            );
    }

    return decoded;
}

/*
 * Parse an incoming email.
 */
function parseEmail(rawEmail) {
    const raw =
        String(rawEmail || "");

    const {
        headers,
        body,
    } = extractMimeBody(raw);

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

    /*
     * Non-multipart message.
     */
    if (
        !/multipart\//i.test(
            contentType
        )
    ) {
        let decodedBody =
            body;

        if (
            /base64/i.test(
                transferEncoding
            )
        ) {
            decodedBody =
                decodeBase64Utf8(
                    body
                );
        } else if (
            /quoted-printable/i.test(
                transferEncoding
            )
        ) {
            decodedBody =
                decodeQuotedPrintable(
                    body
                );
        }

        const isHtml =
            /text\/html/i.test(
                contentType
            );

        const text =
            isHtml
                ? htmlToText(
                    decodedBody
                )
                : decodedBody;

        const html =
            isHtml
                ? decodedBody
                : "";

        return {
            subject:
                subject || "",

            text:
                text || "",

            html:
                html || "",

            intro:
                String(text || "")
                    .replace(
                        /\s+/g,
                        " "
                    )
                    .trim()
                    .slice(0, 200),
        };
    }

    /*
     * Multipart message.
     */
    const boundaryMatch =
        contentType.match(
            /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i
        );

    if (!boundaryMatch) {
        return {
            subject:
                subject || "",

            text:
                body || "",

            html:
                "",

            intro:
                String(body || "")
                    .replace(
                        /\s+/g,
                        " "
                    )
                    .trim()
                    .slice(0, 200),
        };
    }

    const boundary =
        (
            boundaryMatch[1] ||
            boundaryMatch[2] ||
            ""
        ).trim();

    const parts =
        body.split(
            `--${boundary}`
        );

    let text = "";
    let html = "";

    for (const part of parts) {
        if (
            part.trim() ===
            "--"
        ) {
            continue;
        }

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
            !partHeaders
        ) {
            continue;
        }

        const decoded =
            decodeMimePart(
                partHeaders,
                partBody
            ).trim();

        if (
            /text\/plain/i.test(
                partHeaders
            )
        ) {
            if (!text) {
                text =
                    decoded;
            }
        }

        if (
            /text\/html/i.test(
                partHeaders
            )
        ) {
            if (!html) {
                html =
                    decoded;
            }
        }
    }

    if (
        !text &&
        html
    ) {
        text =
            htmlToText(
                html
            );
    }

    return {
        subject:
            subject || "",

        text:
            text || "",

        html:
            html || "",

        intro:
            String(text || "")
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

/*
 * Create mailbox with retry.
 *
 * The frontend normally generates its own address.
 * If the address already exists, return 409.
 */
async function createMailbox(
    db,
    address,
    password
) {
    const id =
        crypto.randomUUID();

    const atIndex =
        address.lastIndexOf("@");

    const localPart =
        atIndex > 0
            ? address.slice(
                0,
                atIndex
            )
            : address;

    const domain =
        atIndex > 0
            ? address.slice(
                atIndex + 1
            )
            : DEFAULT_DOMAIN;

    const createdAt =
        now();

    const expiresAt =
        new Date(
            Date.now() +
                24 *
                    60 *
                    60 *
                    1000
        ).toISOString();

    try {
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
    } catch (error) {
        throw new Error(
            `D1 mailbox INSERT failed: ${
                error?.message ||
                String(error)
            }`
        );
    }

    return {
        id,
        address,
        password,
    };
}

/*
 * GET /domains
 */
async function handleDomains() {
    return json({
        "@context":
            "/contexts/Domain",

        "@id":
            "/domains",

        "@type":
            "hydra:Collection",

        "hydra:totalItems":
            1,

        "hydra:member": [
            {
                "@id":
                    `/domains/${DEFAULT_DOMAIN}`,

                "@type":
                    "Domain",

                id:
                    DEFAULT_DOMAIN,

                domain:
                    DEFAULT_DOMAIN,

                isActive:
                    true,

                isPrivate:
                    false,
            },
        ],
    });
}

/*
 * POST /accounts
 */
async function handleCreateAccount(
    request,
    env
) {
    let db;

    try {
        db =
            getDB(env);

        await verifyDB(db);

        await ensureTables(db);
    } catch (error) {
        console.error(
            "D1 initialization error:",
            error
        );

        return errorResponse(
            "D1 database initialization failed",
            500,
            error
        );
    }

    let payload;

    try {
        payload =
            await request.json();
    } catch {
        return errorResponse(
            "Invalid JSON body",
            400
        );
    }

    let address =
        String(
            payload?.address || ""
        )
            .trim()
            .toLowerCase();

    let password =
        String(
            payload?.password || ""
        );

    /*
     * Allow the backend to generate an address
     * if the client doesn't provide one.
     */
    if (!address) {
        address =
            createEmail();
    }

    if (!password) {
        password =
            randomString(16);
    }

    const expectedSuffix =
        `@${DEFAULT_DOMAIN}`;

    if (
        !address.endsWith(
            expectedSuffix
        )
    ) {
        return errorResponse(
            `Only ${DEFAULT_DOMAIN} is supported`,
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
        localPart.length < 1 ||
        localPart.length > 64
    ) {
        return errorResponse(
            "Invalid email local part",
            422
        );
    }

    /*
     * Prevent duplicate addresses.
     */
    try {
        const existing =
            await db
                .prepare(
                    `
                    SELECT id, active
                    FROM mailboxes
                    WHERE lower(address) = lower(?)
                    LIMIT 1
                    `
                )
                .bind(address)
                .first();

        if (existing) {
            return errorResponse(
                "Email address already exists",
                409
            );
        }
    } catch (error) {
        console.error(
            "Duplicate check failed:",
            error
        );

        return errorResponse(
            "Failed to check mailbox",
            500,
            error
        );
    }

    try {
        const mailbox =
            await createMailbox(
                db,
                address,
                password
            );

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
    } catch (error) {
        console.error(
            "Mailbox creation failed:",
            error
        );

        /*
         * Give the browser the real D1 error.
         * This makes debugging much easier.
         */
        return errorResponse(
            "Failed to create mailbox",
            500,
            error
        );
    }
}

/*
 * POST /session
 */
async function handleSession(
    request,
    env
) {
    let db;

    try {
        db =
            getDB(env);

        await verifyDB(db);

        await ensureTables(db);
    } catch (error) {
        console.error(
            "Session D1 error:",
            error
        );

        return errorResponse(
            "D1 database initialization failed",
            500,
            error
        );
    }

    let payload;

    try {
        payload =
            await request.json();
    } catch {
        return errorResponse(
            "Invalid JSON body",
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
        return errorResponse(
            "address and password are required",
            400
        );
    }

    try {
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
            mailbox.password !==
                password
        ) {
            return errorResponse(
                "Invalid credentials",
                401
            );
        }

        /*
         * Expiration check.
         */
        if (
            mailbox.expires_at &&
            new Date(
                mailbox.expires_at
            ).getTime() <
                Date.now()
        ) {
            await db
                .prepare(
                    `
                    UPDATE mailboxes
                    SET active = 0
                    WHERE id = ?
                    `
                )
                .bind(
                    mailbox.id
                )
                .run();

            return errorResponse(
                "Mailbox expired",
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
    } catch (error) {
        console.error(
            "Session query failed:",
            error
        );

        return errorResponse(
            "Failed to create session",
            500,
            error
        );
    }
}

/*
 * GET /messages
 * GET /messages/:id
 */
async function handleMessages(
    request,
    env,
    route
) {
    let db;

    try {
        db =
            getDB(env);

        await verifyDB(db);

        await ensureTables(db);
    } catch (error) {
        console.error(
            "Messages D1 error:",
            error
        );

        return errorResponse(
            "D1 database initialization failed",
            500,
            error
        );
    }

    const mailboxId =
        getSession(request);

    if (!mailboxId) {
        return errorResponse(
            "Not authenticated",
            401
        );
    }

    let mailbox;

    try {
        mailbox =
            await getMailboxById(
                db,
                mailboxId
            );
    } catch (error) {
        console.error(
            "Mailbox session lookup failed:",
            error
        );

        return errorResponse(
            "Failed to validate session",
            500,
            error
        );
    }

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
        mailbox.expires_at &&
        new Date(
            mailbox.expires_at
        ).getTime() <
            Date.now()
    ) {
        try {
            await db
                .prepare(
                    `
                    UPDATE mailboxes
                    SET active = 0
                    WHERE id = ?
                    `
                )
                .bind(
                    mailbox.id
                )
                .run();
        } catch (error) {
            console.error(
                "Mailbox expiration update failed:",
                error
            );
        }

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

    /*
     * GET /messages
     */
    if (
        route ===
        "/messages"
    ) {
        try {
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
        } catch (error) {
            console.error(
                "Messages list query failed:",
                error
            );

            return errorResponse(
                "Failed to load messages",
                500,
                error
            );
        }
    }

    /*
     * GET /messages/:id
     */
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
            return errorResponse(
                "Message ID is required",
                400
            );
        }

        try {
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
                return errorResponse(
                    "Message not found",
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

            return json({
                id:
                    message.id,

                from: {
                    address:
                        message.sender,
                },

                to:
                    safeParseRecipients(
                        message.recipients
                    ).map(
                        (address) => ({
                            address,
                        })
                    ),

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
        } catch (error) {
            console.error(
                "Message detail query failed:",
                error
            );

            return errorResponse(
                "Failed to load message",
                500,
                error
            );
        }
    }

    return errorResponse(
        "Route not found",
        404
    );
}

/*
 * POST /logout
 */
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

/*
 * POST /receive
 *
 * Your mail receiving system should POST
 * the raw email here.
 *
 * Headers:
 *
 * X-Email-From
 * X-Email-To
 *
 * Body:
 * raw MIME email
 */
async function handleReceive(
    request,
    env
) {
    let db;

    try {
        db =
            getDB(env);

        await verifyDB(db);

        await ensureTables(db);
    } catch (error) {
        console.error(
            "Receive D1 error:",
            error
        );

        return errorResponse(
            "D1 database initialization failed",
            500,
            error
        );
    }

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
        !recipients.length
    ) {
        return errorResponse(
            "Missing recipient",
            400
        );
    }

    /*
     * Only accept our domain.
     */
    const validRecipients =
        recipients.filter(
            (address) =>
                address.endsWith(
                    `@${DEFAULT_DOMAIN}`
                )
        );

    if (
        !validRecipients.length
    ) {
        return errorResponse(
            "No valid recipient for this domain",
            422
        );
    }

    const parsed =
        parseEmail(raw);

    let delivered =
        0;

    try {
        for (
            const recipient
            of validRecipients
        ) {
            const mailbox =
                await getMailbox(
                    db,
                    recipient
                );

            if (!mailbox) {
                continue;
            }

            /*
             * Do not deliver to expired mailbox.
             */
            if (
                mailbox.expires_at &&
                new Date(
                    mailbox.expires_at
                ).getTime() <
                    Date.now()
            ) {
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
                        validRecipients
                    ),
                    parsed.subject,
                    parsed.intro,
                    parsed.text,
                    parsed.html,
                    now()
                )
                .run();

            delivered++;
        }

        return json({
            ok: true,
            delivered,
        });
    } catch (error) {
        console.error(
            "Receive message insert failed:",
            error
        );

        return errorResponse(
            "Failed to store message",
            500,
            error
        );
    }
}

/*
 * Convert Pages [[path]] params into route.
 */
function getRoute(params) {
    const path =
        params?.path;

    if (
        Array.isArray(path)
    ) {
        return (
            "/" +
            path.join("/")
        );
    }

    if (
        typeof path ===
        "string"
    ) {
        return (
            "/" +
            path
        );
    }

    return "/";
}

/*
 * Main Cloudflare Pages Function.
 */
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
        /*
         * CORS / preflight.
         *
         * The frontend is same-origin, but OPTIONS
         * is kept for compatibility.
         */
        if (
            method ===
            "OPTIONS"
        ) {
            return new Response(
                null,
                {
                    status: 204,

                    headers: {
                        Allow:
                            "GET, POST, OPTIONS",

                        "Access-Control-Allow-Methods":
                            "GET, POST, OPTIONS",

                        "Access-Control-Allow-Headers":
                            "Content-Type",

                        "Access-Control-Allow-Credentials":
                            "true",
                    },
                }
            );
        }

        /*
         * GET /domains
         */
        if (
            method === "GET" &&
            route === "/domains"
        ) {
            return handleDomains();
        }

        /*
         * POST /accounts
         */
        if (
            method === "POST" &&
            route === "/accounts"
        ) {
            return handleCreateAccount(
                request,
                env
            );
        }

        /*
         * POST /session
         */
        if (
            method === "POST" &&
            route === "/session"
        ) {
            return handleSession(
                request,
                env
            );
        }

        /*
         * POST /logout
         */
        if (
            method === "POST" &&
            route === "/logout"
        ) {
            return handleLogout();
        }

        /*
         * GET /messages
         * GET /messages/:id
         */
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

        /*
         * POST /receive
         */
        if (
            method === "POST" &&
            route === "/receive"
        ) {
            return handleReceive(
                request,
                env
            );
        }

        return errorResponse(
            "Route not found",
            404
        );
    } catch (error) {
        console.error(
            "tempmail fatal error:",
            error
        );

        return errorResponse(
            "Internal server error",
            500,
            error
        );
    }
}
