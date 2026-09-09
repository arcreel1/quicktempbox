const DEFAULT_DOMAIN = "outlook.dpdns.org";
const COOKIE_NAME = "tm_session";
const SESSION_MAX_AGE = 86400;

/*

============================================================
QuickTempBox
Cloudflare Pages Functions + D1
File:
functions/api/tempmail/[[path]].js
D1 Binding:
DB -> quicktempbox
Routes:
GET /api/tempmail/health
GET /api/tempmail/domains
POST /api/tempmail/accounts
POST /api/tempmail/session
POST /api/tempmail/logout
GET /api/tempmail/messages
GET /api/tempmail/messages/:id
POST /api/tempmail/receive
IMPORTANT:
Database tables must already exist in D1.
Do NOT run CREATE TABLE on every request.
============================================================
*/
/* ============================================================

JSON RESPONSE
============================================================
*/
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

/* ============================================================

COOKIE HELPERS
============================================================
*/
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
${COOKIE_NAME}=${encodeURIComponent(value)},
"Path=/",
Max-Age=${SESSION_MAX_AGE},
"HttpOnly",
"Secure",
"SameSite=Lax",
].join("; ");
}

function clearCookie() {
return [
${COOKIE_NAME}=,
"Path=/",
"Max-Age=0",
"HttpOnly",
"Secure",
"SameSite=Lax",
].join("; ");
}

/* ============================================================

RANDOM EMAIL
============================================================
*/
function randomString(length = 8) {
const chars =
"abcdefghijklmnopqrstuvwxyz0123456789";

const array =
    new Uint8Array(length);

crypto.getRandomValues(array);

let result = "";

for (let i = 0; i < length; i++) {
    result +=
        chars[array[i] % chars.length];
}

return result;

}

function createEmail() {
return ${randomString(8)}@${DEFAULT_DOMAIN};
}

function now() {
return new Date().toISOString();
}

/* ============================================================

D1
============================================================
*/
function getDB(env) {
if (env && env.DB) {
return env.DB;
}

if (env && env.D1) {
    return env.D1;
}

if (env && env.quicktempbox) {
    return env.quicktempbox;
}

return null;

}

/*

We intentionally DO NOT create tables here.
Your D1 database already contains:
mailboxes
messages
idx_messages_mailbox
Creating DDL during every HTTP request can cause
unnecessary locking and runtime failures.
*/
/* ============================================================

DATABASE HELPERS
============================================================
*/
async function getMailbox(db, address) {
return await db
.prepare(
SELECT * FROM mailboxes WHERE lower(address) = lower(?) AND active = 1 LIMIT 1
)
.bind(address)
.first();
}

async function getMailboxById(db, id) {
return await db
.prepare(
SELECT * FROM mailboxes WHERE id = ? AND active = 1 LIMIT 1
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
    createdAt,
    expiresAt,
};

}

/* ============================================================

MESSAGE HELPERS
============================================================
*/
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
            row.sender || "unknown",
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

function makeHydra(messages) {
return {
"hydra:member": messages,
"hydra:totalItems":
messages.length,
};
}

/* ============================================================

MIME DECODING
============================================================
*/
function decodeBase64Utf8(value) {
try {
const binary =
atob(
String(value)
.replace(/\s/g, "")
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
            binary.charCodeAt(i);
    }

    return new TextDecoder(
        "utf-8"
    ).decode(bytes);

} catch {
    return value;
}

}

function decodeQuotedPrintable(value) {
return String(value)
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

                let decoderCharset =
                    "utf-8";

                if (
                    charset
                        .toLowerCase()
                        .includes("gb")
                ) {
                    decoderCharset =
                        "gb18030";
                }

                return new TextDecoder(
                    decoderCharset
                ).decode(bytes);
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

function getHeader(raw, name) {
const escapedName =
name.replace(
/[.*+?^${}()|[]\]/g,
"\$&"
);

const regex =
    new RegExp(
        `^${escapedName}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)$`,
        "im"
    );

const match =
    String(raw).match(regex);

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

function extractMimeBody(raw) {
const separatorMatch =
String(raw).match(
/\r?\n\r?\n/
);

if (!separatorMatch) {
    return {
        headers: String(raw),
        body: "",
    };
}

const index =
    separatorMatch.index;

return {
    headers:
        String(raw).slice(
            0,
            index
        ),

    body:
        String(raw).slice(
            index +
            separatorMatch[0].length
        ),
};

}

function stripHtml(html) {
return String(html)
.replace(
/<style[\s\S]?</style>/gi,
""
)
.replace(
/<script[\s\S]?</script>/gi,
""
)
.replace(
/<br\s*/?>/gi,
"\n"
)
.replace(
/</p>/gi,
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
} =
extractMimeBody(
rawEmail
);

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

let html =
    "";

/*
 * multipart/alternative
 */
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
            const separator =
                part.match(
                    /\r?\n\r?\n/
                );

            if (!separator) {
                continue;
            }

            const partHeadersEnd =
                separator.index;

            const partHeaders =
                part.slice(
                    0,
                    partHeadersEnd
                );

            let partBody =
                part.slice(
                    partHeadersEnd +
                    separator[0].length
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

/*
 * multipart/mixed can contain
 * an alternative section.
 *
 * Basic fallback extraction.
 */
if (
    !text &&
    html
) {
    text =
        stripHtml(
            html
        );
}

/*
 * If body is HTML.
 */
if (
    /^<(!doctype|html|body)/i.test(
        text.trim()
    )
) {
    html =
        text;

    text =
        stripHtml(
            text
        );
}

const cleanText =
    String(text || "")
        .replace(
            /\r\n/g,
            "\n"
        )
        .trim();

return {
    subject:
        subject || "",

    text:
        cleanText,

    html:
        html || "",

    intro:
        cleanText
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

/* ============================================================

ROUTES
============================================================
*/
function getRoute(params) {
const path =
params?.path;

if (
    Array.isArray(path)
) {
    return (
        "/" +
        path
            .map(
                (item) =>
                    String(item)
            )
            .join("/")
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

/* ============================================================

HEALTH CHECK
============================================================
*/
async function handleHealth(env) {
const db =
getDB(env);

if (!db) {
    return json(
        {
            ok: false,
            database: false,
            message:
                "D1 binding DB is missing",
        },
        500
    );
}

try {
    await db
        .prepare(
            "SELECT 1 AS ok"
        )
        .first();

    return json({
        ok: true,
        database: true,
        domain:
            DEFAULT_DOMAIN,
        timestamp:
            now(),
    });

} catch (error) {
    console.error(
        "D1 health check failed:",
        error
    );

    return json(
        {
            ok: false,
            database: false,
            message:
                "D1 database query failed",
            error:
                error?.message ||
                String(error),
        },
        500
    );
}

}

/* ============================================================

DOMAINS
============================================================
*/
async function handleDomains(env) {
const db =
getDB(env);

if (!db) {
    return json(
        {
            message:
                "D1 binding DB is missing",
        },
        500
    );
}

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

/* ============================================================

CREATE ACCOUNT
============================================================
*/
async function handleCreateAccount(
request,
env
) {
const db =
getDB(env);

if (!db) {
    return json(
        {
            message:
                "D1 binding DB is missing. Bind your D1 database as DB and redeploy.",
        },
        500
    );
}

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
        payload?.address ||
        ""
    )
        .trim()
        .toLowerCase();

const password =
    String(
        payload?.password ||
        ""
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

/*
 * Basic email validation.
 */
const emailRegex =
    /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9.-]+$/i;

if (
    !emailRegex.test(
        address
    )
) {
    return json(
        {
            message:
                "Invalid email address",
        },
        422
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

/*
 * Check existing mailbox.
 */
try {
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

} catch (error) {
    console.error(
        "Account lookup failed:",
        error
    );

    return json(
        {
            message:
                "Database lookup failed",
            error:
                error?.message ||
                String(error),
        },
        500
    );
}

/*
 * Create mailbox.
 */
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

            expiresAt:
                mailbox.expiresAt,
        },
        201
    );

} catch (error) {
    console.error(
        "Account creation failed:",
        error
    );

    /*
     * SQLite/D1 UNIQUE race.
     */
    const message =
        String(
            error?.message ||
            ""
        );

    if (
        /unique|constraint/i.test(
            message
        )
    ) {
        return json(
            {
                message:
                    "Email address already exists",
            },
            409
        );
    }

    return json(
        {
            message:
                "Failed to create account",
            error:
                message ||
                String(error),
        },
        500
    );
}

}

/* ============================================================

SESSION LOGIN
============================================================
*/
async function handleSession(
request,
env
) {
const db =
getDB(env);

if (!db) {
    return json(
        {
            message:
                "D1 binding DB is missing",
        },
        500
    );
}

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
        payload?.address ||
        ""
    )
        .trim()
        .toLowerCase();

const password =
    String(
        payload?.password ||
        ""
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
        return json(
            {
                message:
                    "Invalid credentials",
            },
            401
        );
    }

    /*
     * Check expiration.
     */
    if (
        mailbox.expires_at &&
        Date.parse(
            mailbox.expires_at
        ) <= Date.now()
    ) {
        return json(
            {
                message:
                    "Email account expired",
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

} catch (error) {
    console.error(
        "Session error:",
        error
    );

    return json(
        {
            message:
                "Database error",
            error:
                error?.message ||
                String(error),
        },
        500
    );
}

}

/* ============================================================

MESSAGES
============================================================
*/
async function handleMessages(
request,
env,
route
) {
const db =
getDB(env);

if (!db) {
    return json(
        {
            message:
                "D1 binding DB is missing",
        },
        500
    );
}

const mailboxId =
    getSession(
        request
    );

if (!mailboxId) {
    return json(
        {
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
            mailboxId
        );
} catch (error) {
    console.error(
        "Mailbox lookup failed:",
        error
    );

    return json(
        {
            message:
                "Database error",
            error:
                error?.message ||
                String(error),
        },
        500
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

/*
 * Expiration check.
 */
if (
    mailbox.expires_at &&
    Date.parse(
        mailbox.expires_at
    ) <= Date.now()
) {
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
            "Message list error:",
            error
        );

        return json(
            {
                message:
                    "Failed to load messages",
                error:
                    error?.message ||
                    String(error),
            },
            500
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
        return json(
            {
                message:
                    "Message ID is required",
            },
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

        return json({
            id:
                message.id,

            from: {
                address:
                    message.sender ||
                    "unknown",
            },

            to:
                safeRecipients(
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
            "Message detail error:",
            error
        );

        return json(
            {
                message:
                    "Failed to load message",
                error:
                    error?.message ||
                    String(error),
            },
            500
        );
    }
}

return json(
    {
        message:
            "Route not found",
    },
    404
);

}

/* ============================================================

LOGOUT
============================================================
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

/* ============================================================

RECEIVE EMAIL
============================================================
This endpoint expects another mail receiver/Worker to send
the raw email here.
It is NOT automatically called just because the domain has
an MX record.
Expected headers:
X-Email-From
X-Email-To
Body:
raw MIME email
============================================================
*/
async function handleReceive(
request,
env
) {
const db =
getDB(env);

if (!db) {
    return json(
        {
            message:
                "D1 binding DB is missing",
        },
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

if (!to.trim()) {
    return json(
        {
            message:
                "Missing recipient",
        },
        400
    );
}

const recipients =
    to
        .split(",")
        .map(
            (value) =>
                value
                    .trim()
                    .toLowerCase()
        )
        .filter(Boolean);

if (
    !recipients.length
) {
    return json(
        {
            message:
                "Missing recipient",
        },
        400
    );
}

let raw;

try {
    raw =
        await request.text();
} catch {
    return json(
        {
            message:
                "Unable to read email body",
        },
        400
    );
}

const parsed =
    parseEmail(
        raw
    );

let inserted =
    0;

try {
    for (
        const recipient
        of recipients
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
         * Do not accept messages for
         * expired mailboxes.
         */
        if (
            mailbox.expires_at &&
            Date.parse(
                mailbox.expires_at
            ) <= Date.now()
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

} catch (error) {
    console.error(
        "Receive email error:",
        error
    );

    return json(
        {
            message:
                "Failed to store email",
            error:
                error?.message ||
                String(error),
        },
        500
    );
}

}

/* ============================================================

OPTIONS
============================================================
*/
function handleOptions() {
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
                "Content-Type, X-Email-From, X-Email-To",

            "Access-Control-Allow-Credentials":
                "true",
        },
    }
);

}

/* ============================================================

MAIN HANDLER
============================================================
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
    request.method.toUpperCase();

const route =
    getRoute(
        params
    );

/*
 * Always allow OPTIONS.
 */
if (
    method ===
    "OPTIONS"
) {
    return handleOptions();
}

/*
 * Health endpoint.
 *
 * /api/tempmail/health
 */
if (
    method === "GET" &&
    route === "/health"
) {
    return handleHealth(
        env
    );
}

/*
 * Domains.
 */
if (
    method === "GET" &&
    route === "/domains"
) {
    return handleDomains(
        env
    );
}

/*
 * Create account.
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
 * Login.
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
 * Logout.
 */
if (
    method === "POST" &&
    route === "/logout"
) {
    return handleLogout();
}

/*
 * Inbox.
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
    return handleMessages(
        request,
        env,
        route
    );
}

/*
 * Receive raw email.
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

return json(
    {
        message:
            "Route not found",
        route,
        method,
    },
    404
);

}
