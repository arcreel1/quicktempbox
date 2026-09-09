const DEFAULT_DOMAIN = "outlook.dpdns.org";
const COOKIE_NAME = "tm_session";
const SESSION_MAX_AGE = 86400;

// ============================================================
// JSON Response
// ============================================================

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

// ============================================================
// Error helpers
// ============================================================

function errorMessage(error) {
    if (!error) {
        return "Unknown error";
    }

    if (error instanceof Error) {
        return error.message || error.toString();
    }

    if (typeof error === "string") {
        return error;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function detailedError(message, error, extra = {}) {
    return {
        ok: false,
        message,
        error: errorMessage(error),
        ...extra,
    };
}

// ============================================================
// Cookies
// ============================================================

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

// ============================================================
// Random
// ============================================================

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

function now() {
    return new Date().toISOString();
}

// ============================================================
// D1
// ============================================================

function getDB(env) {
    if (!env) {
        return null;
    }

    return (
        env.DB ||
        env.D1 ||
        env.quicktempbox ||
        null
    );
}

function checkDB(env) {
    const db = getDB(env);

    if (!db) {
        return {
            ok: false,
            db: null,
            error:
                "D1 binding not found. Expected binding name: DB",
        };
    }

    return {
        ok: true,
        db,
    };
}

// ============================================================
// Database initialization
// ============================================================

async function ensureTables(db) {
    if (!db) {
        throw new Error(
            "D1 database binding is missing."
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

// ============================================================
// Mailbox helpers
// ============================================================

function normalizeAddress(address) {
    return String(address || "")
        .trim()
        .toLowerCase();
}

function isValidAddress(address) {
    if (!address) {
        return false;
    }

    if (address.length > 320) {
        return false;
    }

    const parts = address.split("@");

    if (parts.length !== 2) {
        return false;
    }

    const local = parts[0];
    const domain = parts[1];

    if (!local || !domain) {
        return false;
    }

    return true;
}

async function getMailbox(db, address) {
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

async function getMailboxById(db, id) {
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
    const id = crypto.randomUUID();

    const parts = address.split("@");

    const localPart = parts[0];
    const domain = parts[1];

    const createdAt = now();

    const expiresAt =
        new Date(
            Date.now() +
            24 * 60 * 60 * 1000
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
            `Mailbox INSERT failed: ${errorMessage(error)}`
        );
    }

    return {
        id,
        address,
        password,
        createdAt,
        expiresAt,
    };
}

// ============================================================
// /domains
// ============================================================

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
                id: DEFAULT_DOMAIN,
                domain: DEFAULT_DOMAIN,
                isActive: true,
                isPrivate: false,
            },
        ],
    });
}

// ============================================================
// /accounts
// ============================================================

async function handleCreateAccount(
    request,
    env
) {
    const dbCheck = checkDB(env);

    if (!dbCheck.ok) {
        return json(
            detailedError(
                "D1 binding error",
                dbCheck.error,
                {
                    expectedBinding: "DB",
                    hint:
                        "Cloudflare Pages > Settings > Functions > Bindings > D1 Database > DB > quicktempbox",
                }
            ),
            500
        );
    }

    const db = dbCheck.db;

    try {
        await ensureTables(db);
    } catch (error) {
        return json(
            detailedError(
                "Failed to initialize D1 database",
                error
            ),
            500
        );
    }

    let payload;

    try {
        payload = await request.json();
    } catch (error) {
        return json(
            detailedError(
                "Invalid JSON body",
                error
            ),
            400
        );
    }

    const address =
        normalizeAddress(
            payload?.address
        );

    const password =
        String(
            payload?.password || ""
        );

    if (!address || !password) {
        return json(
            {
                ok: false,
                message:
                    "address and password are required",
            },
            400
        );
    }

    if (!isValidAddress(address)) {
        return json(
            {
                ok: false,
                message:
                    "Invalid email address format",
                address,
            },
            422
        );
    }

    const expectedSuffix =
        `@${DEFAULT_DOMAIN}`;

    if (!address.endsWith(expectedSuffix)) {
        return json(
            {
                ok: false,
                message:
                    `Only ${DEFAULT_DOMAIN} is supported`,
                expectedDomain:
                    DEFAULT_DOMAIN,
                receivedAddress:
                    address,
            },
            422
        );
    }

    // 防止 local part 为空
    const localPart =
        address.slice(
            0,
            -expectedSuffix.length
        );

    if (!localPart) {
        return json(
            {
                ok: false,
                message:
                    "Email local part cannot be empty",
            },
            422
        );
    }

    // 防止重复邮箱
    let existing;

    try {
        existing =
            await db
                .prepare(
                    `
                    SELECT
                        id,
                        address,
                        active,
                        created_at,
                        expires_at
                    FROM mailboxes
                    WHERE lower(address) = lower(?)
                    LIMIT 1
                    `
                )
                .bind(address)
                .first();
    } catch (error) {
        return json(
            detailedError(
                "Failed to check existing mailbox",
                error,
                {
                    address,
                }
            ),
            500
        );
    }

    if (existing) {
        return json(
            {
                ok: false,
                message:
                    "Email address already exists",
                mailbox: existing,
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
        return json(
            detailedError(
                "Failed to create mailbox",
                error,
                {
                    address,
                    domain:
                        DEFAULT_DOMAIN,
                    hint:
                        "Check D1 binding DB and the mailboxes table.",
                }
            ),
            500
        );
    }

    return json(
        {
            "@type": "Account",
            ok: true,
            id: mailbox.id,
            address: mailbox.address,
            expiresAt:
                mailbox.expiresAt,
        },
        201
    );
}

// ============================================================
// /session
// ============================================================

async function handleSession(
    request,
    env
) {
    const dbCheck = checkDB(env);

    if (!dbCheck.ok) {
        return json(
            detailedError(
                "D1 binding error",
                dbCheck.error,
                {
                    expectedBinding: "DB",
                }
            ),
            500
        );
    }

    const db = dbCheck.db;

    try {
        await ensureTables(db);
    } catch (error) {
        return json(
            detailedError(
                "Failed to initialize D1 database",
                error
            ),
            500
        );
    }

    let payload;

    try {
        payload = await request.json();
    } catch (error) {
        return json(
            detailedError(
                "Invalid JSON body",
                error
            ),
            400
        );
    }

    const address =
        normalizeAddress(
            payload?.address
        );

    const password =
        String(
            payload?.password || ""
        );

    if (!address || !password) {
        return json(
            {
                ok: false,
                message:
                    "address and password are required",
            },
            400
        );
    }

    let mailbox;

    try {
        mailbox =
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
    } catch (error) {
        return json(
            detailedError(
                "Failed to query mailbox",
                error,
                {
                    address,
                }
            ),
            500
        );
    }

    if (!mailbox) {
        return json(
            {
                ok: false,
                message:
                    "Mailbox not found",
                address,
            },
            401
        );
    }

    if (mailbox.password !== password) {
        return json(
            {
                ok: false,
                message:
                    "Invalid password",
            },
            401
        );
    }

    return json(
        {
            ok: true,
            id: mailbox.id,
            address: mailbox.address,
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

// ============================================================
// Message list formatter
// ============================================================

function safeRecipients(value) {
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
                row.sender ||
                "unknown",
        },
        to: safeRecipients(
            row.recipients
        ).map(
            (address) => ({
                address,
            })
        ),
        subject:
            row.subject || "",
        intro:
            row.intro || "",
        createdAt:
            row.received_at,
        seen:
            Boolean(row.seen),
        hasAttachments:
            Boolean(
                row.has_attachments
            ),
    };
}

// ============================================================
// /messages
// /messages/:id
// ============================================================

async function handleMessages(
    request,
    env,
    route
) {
    const dbCheck = checkDB(env);

    if (!dbCheck.ok) {
        return json(
            detailedError(
                "D1 binding error",
                dbCheck.error
            ),
            500
        );
    }

    const db = dbCheck.db;

    try {
        await ensureTables(db);
    } catch (error) {
        return json(
            detailedError(
                "Failed to initialize D1 database",
                error
            ),
            500
        );
    }

    const sessionId =
        getSession(request);

    if (!sessionId) {
        return json(
            {
                ok: false,
                message:
                    "Not authenticated",
            },
            401
        );
    }

    let mailbox;

    try {
        mailbox =
            await getMailboxById(
                db,
                sessionId
            );
    } catch (error) {
        return json(
            detailedError(
                "Failed to validate session",
                error
            ),
            500
        );
    }

    if (!mailbox) {
        return json(
            {
                ok: false,
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

    // --------------------------------------------------------
    // GET /messages
    // --------------------------------------------------------

    if (route === "/messages") {
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

            return json({
                "@context":
                    "/contexts/Message",
                "@id":
                    "/messages",
                "@type":
                    "hydra:Collection",
                "hydra:member":
                    messages,
                "hydra:totalItems":
                    messages.length,
            });
        } catch (error) {
            return json(
                detailedError(
                    "Failed to load messages",
                    error,
                    {
                        mailboxId:
                            mailbox.id,
                    }
                ),
                500
            );
        }
    }

    // --------------------------------------------------------
    // GET /messages/:id
    // --------------------------------------------------------

    const prefix =
        "/messages/";

    if (
        route.startsWith(prefix)
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
                    ok: false,
                    message:
                        "Message ID is required",
                },
                400
            );
        }

        let message;

        try {
            message =
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
        } catch (error) {
            return json(
                detailedError(
                    "Failed to load message",
                    error,
                    {
                        messageId:
                            id,
                    }
                ),
                500
            );
        }

        if (!message) {
            return json(
                {
                    ok: false,
                    message:
                        "Message not found",
                },
                404
            );
        }

        try {
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
        } catch (error) {
            console.error(
                "Failed to mark message as read:",
                error
            );
        }

        return json({
            id: message.id,
            from: {
                address:
                    message.sender ||
                    "unknown",
            },
            to: safeRecipients(
                message.recipients
            ).map(
                (address) => ({
                    address,
                })
            ),
            subject:
                message.subject || "",
            intro:
                message.intro || "",
            text:
                message.text || "",
            html:
                message.html || "",
            createdAt:
                message.received_at,
            seen: true,
            hasAttachments:
                Boolean(
                    message.has_attachments
                ),
        });
    }

    return json(
        {
            ok: false,
            message:
                "Route not found",
            route,
        },
        404
    );
}

// ============================================================
// /logout
// ============================================================

async function handleLogout() {
    return json(
        {
            ok: true,
            message:
                "Logged out",
        },
        200,
        {
            "Set-Cookie":
                clearCookie(),
        }
    );
}

// ============================================================
// MIME decoding
// ============================================================

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
        return value;
    }
}

function decodeQuotedPrintable(
    value
) {
    return String(value || "")
        .replace(
            /=\r?\n/g,
            ""
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
}

function decodeMimeWord(value) {
    if (!value) {
        return "";
    }

    return String(value).replace(
        /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g,
        (
            _,
            charset,
            encoding,
            content
        ) => {
            try {
                if (
                    encoding.toLowerCase() ===
                    "b"
                ) {
                    const binary =
                        atob(
                            content
                        );

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
                            binary.charCodeAt(
                                i
                            );
                    }

                    const decoderCharset =
                        charset
                            .toLowerCase()
                            .includes("gb")
                            ? "gb18030"
                            : "utf-8";

                    return new TextDecoder(
                        decoderCharset
                    ).decode(
                        bytes
                    );
                }

                return content
                    .replace(
                        /_/g,
                        " "
                    )
                    .replace(
                        /=([0-9A-Fa-f]{2})/g,
                        (
                            _,
                            hex
                        ) =>
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

// ============================================================
// MIME headers
// ============================================================

function getHeader(
    raw,
    name
) {
    const regex =
        new RegExp(
            `^${name}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)$`,
            "im"
        );

    const match =
        String(raw || "").match(
            regex
        );

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

function extractMimeBody(rawEmail) {
    const raw =
        String(rawEmail || "");

    const headerEnd =
        raw.search(
            /\r?\n\r?\n/
        );

    if (
        headerEnd === -1
    ) {
        return {
            headers: raw,
            body: "",
        };
    }

    const separator =
        raw.match(
            /\r?\n\r?\n/
        );

    return {
        headers:
            raw.slice(
                0,
                headerEnd
            ),
        body:
            raw.slice(
                headerEnd +
                    separator[0]
                        .length
            ),
    };
}

// ============================================================
// MIME parser
// ============================================================

function parseEmail(rawEmail) {
    const {
        headers,
        body,
    } =
        extractMimeBody(
            rawEmail
        );

    let subject =
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

    let text =
        decodedBody;

    let html = "";

    // --------------------------------------------------------
    // multipart/alternative
    // --------------------------------------------------------

    if (
        /multipart\/alternative/i.test(
            contentType
        )
    ) {
        const boundaryMatch =
            contentType.match(
                /boundary="?([^";]+)"?/i
            );

        if (
            boundaryMatch
        ) {
            const boundary =
                boundaryMatch[1];

            const parts =
                decodedBody.split(
                    `--${boundary}`
                );

            for (
                const part of parts
            ) {
                const partHeaderEnd =
                    part.search(
                        /\r?\n\r?\n/
                    );

                if (
                    partHeaderEnd === -1
                ) {
                    continue;
                }

                const separator =
                    part.match(
                        /\r?\n\r?\n/
                    );

                const partHeaders =
                    part.slice(
                        0,
                        partHeaderEnd
                    );

                let partBody =
                    part.slice(
                        partHeaderEnd +
                            separator[0]
                                .length
                    );

                const partEncoding =
                    getHeader(
                        partHeaders,
                        "Content-Transfer-Encoding"
                    );

                if (
                    /base64/i.test(
                        partEncoding
                    )
                ) {
                    partBody =
                        decodeBase64Utf8(
                            partBody
                        );
                } else if (
                    /quoted-printable/i.test(
                        partEncoding
                    )
                ) {
                    partBody =
                        decodeQuotedPrintable(
                            partBody
                        );
                }

                if (
                    /text\/html/i.test(
                        partHeaders
                    )
                ) {
                    html =
                        partBody.trim();
                }

                if (
                    /text\/plain/i.test(
                        partHeaders
                    )
                ) {
                    text =
                        partBody.trim();
                }
            }
        }
    }

    // --------------------------------------------------------
    // HTML fallback
    // --------------------------------------------------------

    if (
        !text &&
        html
    ) {
        text =
            html
                .replace(
                    /<style[\s\S]*?<\/style>/gi,
                    ""
                )
                .replace(
                    /<script[\s\S]*?<\/script>/gi,
                    ""
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
                .slice(
                    0,
                    200
                ),
    };
}

// ============================================================
// /receive
// ============================================================

async function handleReceive(
    request,
    env
) {
    const dbCheck = checkDB(env);

    if (!dbCheck.ok) {
        return json(
            detailedError(
                "D1 binding error",
                dbCheck.error
            ),
            500
        );
    }

    const db = dbCheck.db;

    try {
        await ensureTables(db);
    } catch (error) {
        return json(
            detailedError(
                "Failed to initialize D1 database",
                error
            ),
            500
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
                    normalizeAddress(
                        x
                    )
            )
            .filter(Boolean);

    if (
        !recipients.length
    ) {
        return json(
            {
                ok: false,
                message:
                    "Missing recipient",
                hint:
                    "Send recipient in X-Email-To header.",
            },
            400
        );
    }

    let parsed;

    try {
        parsed =
            parseEmail(
                raw
            );
    } catch (error) {
        return json(
            detailedError(
                "Failed to parse MIME email",
                error
            ),
            400
        );
    }

    const inserted = [];
    const skipped = [];

    for (
        const recipient of recipients
    ) {
        let mailbox;

        try {
            mailbox =
                await getMailbox(
                    db,
                    recipient
                );
        } catch (error) {
            return json(
                detailedError(
                    "Failed to find recipient mailbox",
                    error,
                    {
                        recipient,
                    }
                ),
                500
            );
        }

        if (!mailbox) {
            skipped.push(
                recipient
            );
            continue;
        }

        const id =
            crypto.randomUUID();

        try {
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
        } catch (error) {
            return json(
                detailedError(
                    "Failed to insert message",
                    error,
                    {
                        messageId:
                            id,
                        recipient,
                        mailboxId:
                            mailbox.id,
                    }
                ),
                500
            );
        }

        inserted.push({
            id,
            recipient,
        });
    }

    return json({
        ok: true,
        inserted,
        skipped,
        subject:
            parsed.subject,
    });
}

// ============================================================
// Route
// ============================================================

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
        return "/" + path;
    }

    return "/";
}

// ============================================================
// Main Pages Function
// ============================================================

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
        // ----------------------------------------------------
        // OPTIONS
        // ----------------------------------------------------

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
                    },
                }
            );
        }

        // ----------------------------------------------------
        // GET /domains
        // ----------------------------------------------------

        if (
            method === "GET" &&
            route === "/domains"
        ) {
            return handleDomains();
        }

        // ----------------------------------------------------
        // POST /accounts
        // ----------------------------------------------------

        if (
            method === "POST" &&
            route === "/accounts"
        ) {
            return handleCreateAccount(
                request,
                env
            );
        }

        // ----------------------------------------------------
        // POST /session
        // ----------------------------------------------------

        if (
            method === "POST" &&
            route === "/session"
        ) {
            return handleSession(
                request,
                env
            );
        }

        // ----------------------------------------------------
        // POST /logout
        // ----------------------------------------------------

        if (
            method === "POST" &&
            route === "/logout"
        ) {
            return handleLogout();
        }

        // ----------------------------------------------------
        // GET /messages
        // GET /messages/:id
        // ----------------------------------------------------

        if (
            method === "GET" &&
            (
                route === "/messages" ||
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

        // ----------------------------------------------------
        // POST /receive
        // ----------------------------------------------------

        if (
            method === "POST" &&
            route === "/receive"
        ) {
            return handleReceive(
                request,
                env
            );
        }

        // ----------------------------------------------------
        // Unknown route
        // ----------------------------------------------------

        return json(
            {
                ok: false,
                message:
                    "Route not found",
                route,
                method,
            },
            404
        );
    } catch (error) {
        console.error(
            "tempmail error:",
            error
        );

        return json(
            detailedError(
                "Internal server error",
                error,
                {
                    route,
                    method,
                }
            ),
            500
        );
    }
}
