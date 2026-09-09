let account = null;
let inboxInterval = null;

const API_BASE = "/api/tempmail";
const CUSTOM_DOMAIN = "outlook.dpdns.org";

async function apiRequest(path, options = {}) {
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            credentials: "same-origin",
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {}),
            },
        });

        let data = null;

        try {
            data = await response.json();
        } catch {
            data = null;
        }

        return {
            response,
            data,
        };
    } catch (error) {
        console.error("API request failed:", error);

        return {
            response: {
                ok: false,
                status: 0,
            },
            data: null,
        };
    }
}

function resetSessionState(clearEmailDisplay = true) {
    account = null;

    localStorage.removeItem("tm_email");
    localStorage.removeItem("tm_read_messages");

    if (inboxInterval) {
        clearInterval(inboxInterval);
        inboxInterval = null;
    }

    if (clearEmailDisplay) {
        const emailDisplay = document.getElementById("emailDisplay");

        if (emailDisplay) {
            emailDisplay.innerText = "---";
        }
    }
}

async function generateAccount() {
    try {
        showAlert("Creating temporary email...");

        const username = Math.random()
            .toString(36)
            .substring(2, 10);

        const password = Math.random()
            .toString(36)
            .substring(2, 12);

        /*
         * We intentionally use your Cloudflare/Mail.tm domain.
         * We do not depend on /domains to select the domain.
         */
        const address = `${username}@${CUSTOM_DOMAIN}`;

        console.log("Creating account:", address);

        const accountResult = await apiRequest("/accounts", {
            method: "POST",
            body: JSON.stringify({
                address,
                password,
            }),
        });

        console.log("Account response:", accountResult);

        if (!accountResult.response.ok) {
            console.error(
                "Account creation failed:",
                accountResult.data
            );

            showAlert(
                accountResult.data?.message ||
                "Failed to create temp email. Please try again."
            );

            return;
        }

        /*
         * Login immediately after account creation.
         */
        const sessionResult = await apiRequest("/session", {
            method: "POST",
            body: JSON.stringify({
                address,
                password,
            }),
        });

        console.log("Session response:", sessionResult);

        if (!sessionResult.response.ok) {
            console.error(
                "Session creation failed:",
                sessionResult.data
            );

            showAlert(
                "Email created, but login session failed."
            );

            return;
        }

        account = {
            address,
            password,
        };

        const emailDisplay =
            document.getElementById("emailDisplay");

        if (emailDisplay) {
            emailDisplay.innerText = address;
        }

        localStorage.setItem("tm_email", address);

        /*
         * Clear previous messages.
         */
        const inbox = document.getElementById("inbox");

        if (inbox) {
            inbox.innerHTML = "<p>No messages yet.</p>";
        }

        /*
         * Restart inbox polling.
         */
        if (inboxInterval) {
            clearInterval(inboxInterval);
        }

        await checkInbox();

        inboxInterval = setInterval(() => {
            checkInbox();
        }, 15000);

        showAlert("Email account created successfully!");
    } catch (error) {
        console.error("generateAccount error:", error);

        showAlert("An error occurred. Please try again.");
    }
}

function showAlert(message) {
    const alert = document.getElementById("alert");
    const alertMessage =
        document.getElementById("alertMessage");

    if (alert && alertMessage) {
        alertMessage.textContent = message;

        alert.classList.add("show");

        setTimeout(() => {
            closeAlert();
        }, 3000);
    } else {
        console.log("Alert:", message);
    }
}

function closeAlert() {
    const alert = document.getElementById("alert");

    if (alert) {
        alert.classList.remove("show");
    }
}

function copyEmail() {
    const email =
        document.getElementById("emailDisplay")?.innerText;

    if (!email || email === "---") {
        showAlert("Please generate an email first!");
        return;
    }

    const copyIcons =
        document.querySelectorAll(".fa-copy");

    copyIcons.forEach((icon) => {
        icon.classList.remove("icon-animate-copy");

        void icon.offsetWidth;

        icon.classList.add("icon-animate-copy");
    });

    if (!navigator.clipboard) {
        showAlert("Clipboard is not available.");
        return;
    }

    navigator.clipboard
        .writeText(email)
        .then(() => {
            showAlert("Email copied to clipboard!");
        })
        .catch((error) => {
            console.error("Copy failed:", error);
            showAlert("Failed to copy email.");
        });
}

function triggerSpin(icon) {
    if (!icon) {
        return;
    }

    icon.classList.remove("animate-spin");

    void icon.offsetWidth;

    icon.classList.add("animate-spin");
}

function refreshInbox() {
    const icon =
        document.getElementById("inboxRefreshIcon");

    if (icon) {
        icon.classList.remove(
            "icon-animate-refresh"
        );

        void icon.offsetWidth;

        icon.classList.add(
            "icon-animate-refresh"
        );
    }

    checkInbox().finally(() => {
        if (icon) {
            setTimeout(() => {
                icon.classList.remove(
                    "icon-animate-refresh"
                );
            }, 800);
        }
    });
}

function getReadMessages() {
    try {
        const stored =
            localStorage.getItem("tm_read_messages");

        if (!stored) {
            return [];
        }

        const parsed = JSON.parse(stored);

        return Array.isArray(parsed)
            ? parsed
            : [];
    } catch {
        return [];
    }
}

function markMessageAsRead(messageId) {
    const readMessages = getReadMessages();

    if (!readMessages.includes(messageId)) {
        readMessages.push(messageId);

        localStorage.setItem(
            "tm_read_messages",
            JSON.stringify(readMessages)
        );
    }
}

/*
 * Safely escape HTML.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) {
        return "";
    }

    const div = document.createElement("div");

    div.textContent = String(value);

    return div.innerHTML;
}

/*
 * Convert URLs into clickable links.
 */
function linkify(text) {
    const escaped = escapeHtml(text);

    return escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/*
 * Extract useful text from Mail.tm message response.
 */
function getMessageText(data) {
    if (!data) {
        return "";
    }

    /*
     * Normal Mail.tm text message.
     */
    if (
        typeof data.text === "string" &&
        data.text.trim()
    ) {
        return data.text;
    }

    /*
     * Sometimes the API may return an array.
     */
    if (Array.isArray(data.text)) {
        const text = data.text
            .filter(Boolean)
            .join("\n");

        if (text.trim()) {
            return text;
        }
    }

    /*
     * Try intro as fallback.
     */
    if (
        typeof data.intro === "string" &&
        data.intro.trim()
    ) {
        return data.intro;
    }

    /*
     * Try HTML body as final fallback.
     */
    if (
        typeof data.html === "string" &&
        data.html.trim()
    ) {
        const temp = document.createElement("div");

        temp.innerHTML = data.html;

        return temp.innerText || "";
    }

    if (Array.isArray(data.html)) {
        const html = data.html
            .filter(Boolean)
            .join("\n");

        const temp = document.createElement("div");

        temp.innerHTML = html;

        return temp.innerText || "";
    }

    return "";
}

async function checkInbox() {
    if (!account) {
        return;
    }

    const inbox =
        document.getElementById("inbox");

    if (!inbox) {
        return;
    }

    try {
        const inboxResult = await apiRequest(
            "/messages",
            {
                method: "GET",
            }
        );

        console.log(
            "Messages response:",
            inboxResult
        );

        if (
            inboxResult.response.status === 401
        ) {
            resetSessionState(false);

            inbox.innerHTML =
                "<p>Session expired. Generate a new email.</p>";

            showAlert(
                "Session expired. Please generate a new email."
            );

            return;
        }

        if (!inboxResult.response.ok) {
            inbox.innerHTML =
                "<p>Failed to load inbox.</p>";

            showAlert(
                "Failed to load inbox."
            );

            return;
        }

        const inboxData =
            inboxResult.data || {};

        const messages =
            Array.isArray(
                inboxData["hydra:member"]
            )
                ? inboxData["hydra:member"]
                : [];

        inbox.innerHTML = "";

        if (messages.length === 0) {
            inbox.innerHTML =
                "<p>No messages yet.</p>";

            return;
        }

        const readMessages =
            getReadMessages();

        messages.forEach((msg) => {
            const messageDiv =
                document.createElement("div");

            messageDiv.classList.add(
                "message"
            );

            const messageId = msg.id;

            const isRead =
                msg.seen ||
                readMessages.includes(messageId);

            messageDiv.classList.add(
                isRead
                    ? "read"
                    : "unread"
            );

            messageDiv.dataset.messageId =
                messageId || "";

            const receivedDate =
                msg.createdAt
                    ? new Date(
                        msg.createdAt
                    ).toLocaleString()
                    : "";

            const fromAddress =
                msg.from?.address ||
                "Unknown sender";

            const subject =
                msg.subject ||
                "(No subject)";

            const preview =
                msg.intro ||
                "";

            const header =
                document.createElement("div");

            header.classList.add(
                "message-header"
            );

            header.innerHTML = `
                <strong>From:</strong>
                ${escapeHtml(fromAddress)}
                <br>

                <strong>Subject:</strong>
                ${escapeHtml(subject)}
                <br>

                <strong>Time:</strong>
                ${escapeHtml(receivedDate)}
                <br>

                <strong>Preview:</strong>
                ${escapeHtml(preview)}
            `;

            messageDiv.appendChild(header);

            messageDiv.onclick = () => {
                showMessage(
                    messageId,
                    messageDiv
                );
            };

            inbox.appendChild(
                messageDiv
            );
        });
    } catch (error) {
        console.error(
            "checkInbox error:",
            error
        );

        inbox.innerHTML =
            "<p>Error loading messages.</p>";

        showAlert(
            "Error loading inbox."
        );
    }
}

async function showMessage(id, div) {
    if (!id || !div) {
        return;
    }

    /*
     * Toggle message body.
     */
    const existingBody =
        div.querySelector(
            ".message-body"
        );

    if (existingBody) {
        existingBody.remove();
        return;
    }

    div.classList.remove(
        "unread"
    );

    div.classList.add(
        "read"
    );

    markMessageAsRead(id);

    /*
     * Loading indicator.
     */
    const loadingDiv =
        document.createElement("div");

    loadingDiv.classList.add(
        "message-body"
    );

    loadingDiv.innerHTML =
        "<p>Loading message...</p>";

    div.appendChild(
        loadingDiv
    );

    try {
        console.log(
            "Loading message:",
            id
        );

        const messageResult =
            await apiRequest(
                `/messages/${encodeURIComponent(id)}`,
                {
                    method: "GET",
                }
            );

        console.log(
            "Message detail response:",
            messageResult
        );

        if (
            !messageResult.response.ok
        ) {
            throw new Error(
                `HTTP ${messageResult.response.status}`
            );
        }

        const data =
            messageResult.data || {};

        /*
         * Remove loading box.
         */
        loadingDiv.remove();

        const body =
            getMessageText(data);

        const newDiv =
            document.createElement("div");

        newDiv.classList.add(
            "message-body"
        );

        /*
         * Message content.
         */
        const contentDiv =
            document.createElement("div");

        contentDiv.classList.add(
            "message-content"
        );

        if (body.trim()) {
            contentDiv.innerHTML =
                linkify(body);
        } else {
            /*
             * Show useful debugging information
             * instead of simply displaying blank.
             */
            contentDiv.innerHTML = `
                <p>
                    No message content.
                </p>
            `;
        }

        /*
         * Controls.
         */
        const controlsDiv =
            document.createElement("div");

        controlsDiv.classList.add(
            "message-controls"
        );

        /*
         * Copy button.
         */
        const copyButton =
            document.createElement("button");

        copyButton.classList.add(
            "message-copy"
        );

        copyButton.type = "button";

        copyButton.title =
            "Copy message";

        copyButton.innerHTML =
            '<i class="fas fa-copy"></i>';

        copyButton.onclick = (e) => {
            e.stopPropagation();

            if (!body.trim()) {
                showAlert(
                    "No message content to copy."
                );

                return;
            }

            if (!navigator.clipboard) {
                showAlert(
                    "Clipboard is not available."
                );

                return;
            }

            navigator.clipboard
                .writeText(body)
                .then(() => {
                    showAlert(
                        "Message content copied!"
                    );
                })
                .catch(() => {
                    showAlert(
                        "Failed to copy."
                    );
                });
        };

        /*
         * Close button.
         */
        const closeButton =
            document.createElement("button");

        closeButton.classList.add(
            "message-close"
        );

        closeButton.type = "button";

        closeButton.title =
            "Close message";

        closeButton.innerHTML =
            '<i class="fas fa-times"></i>';

        closeButton.onclick = (e) => {
            e.stopPropagation();

            newDiv.remove();
        };

        controlsDiv.appendChild(
            copyButton
        );

        controlsDiv.appendChild(
            closeButton
        );

        newDiv.appendChild(
            contentDiv
        );

        newDiv.appendChild(
            controlsDiv
        );

        newDiv.onclick = (e) => {
            e.stopPropagation();
        };

        div.appendChild(
            newDiv
        );
    } catch (error) {
        console.error(
            "showMessage error:",
            error
        );

        loadingDiv.innerHTML = `
            <p>
                Failed to load message content.
            </p>
        `;

        showAlert(
            "Failed to load message content."
        );
    }
}

async function deleteAccount() {
    if (!account) {
        showAlert(
            "No active email to delete."
        );

        return;
    }

    const deleteIcon =
        document.querySelector(
            ".action-button.delete i"
        );

    if (deleteIcon) {
        deleteIcon.classList.remove(
            "icon-animate-delete"
        );

        void deleteIcon.offsetWidth;

        deleteIcon.classList.add(
            "icon-animate-delete"
        );
    }

    try {
        await apiRequest(
            "/logout",
            {
                method: "POST",
            }
        );
    } catch (error) {
        console.error(
            "Logout error:",
            error
        );
    }

    const inbox =
        document.getElementById("inbox");

    if (inbox) {
        inbox.innerHTML =
            "<p>No messages yet.</p>";
    }

    resetSessionState(true);

    showAlert(
        "Email address deleted!"
    );
}

/*
 * Refresh icons.
 */
document.addEventListener(
    "DOMContentLoaded",
    () => {
        const emailIcon =
            document.getElementById(
                "emailRefreshIcon"
            );

        const inboxIcon =
            document.getElementById(
                "inboxRefreshIcon"
            );

        if (emailIcon) {
            emailIcon.addEventListener(
                "click",
                () => {
                    triggerSpin(
                        emailIcon
                    );
                }
            );
        }

        if (inboxIcon) {
            inboxIcon.addEventListener(
                "click",
                () => {
                    triggerSpin(
                        inboxIcon
                    );
                }
            );
        }
    }
);

/*
 * Current year.
 */
const yearEl =
    document.getElementById(
        "currentYear"
    );

if (yearEl) {
    yearEl.textContent =
        new Date().getFullYear();
}

/*
 * Mobile menu.
 */
const mobileMenuBtn =
    document.querySelector(
        ".mobile-menu-btn"
    );

const mainNav =
    document.querySelector(
        ".main-nav"
    );

if (
    mobileMenuBtn &&
    mainNav
) {
    mobileMenuBtn.addEventListener(
        "click",
        () => {
            mainNav.classList.toggle(
                "show"
            );
        }
    );
}

/*
 * Close mobile menu after navigation.
 */
document
    .querySelectorAll(
        ".main-nav a"
    )
    .forEach((link) => {
        link.addEventListener(
            "click",
            () => {
                mainNav?.classList.remove(
                    "show"
                );
            }
        );
    });

/*
 * Smooth scrolling.
 */
document
    .querySelectorAll(
        'a[href^="#"]'
    )
    .forEach((anchor) => {
        anchor.addEventListener(
            "click",
            function (e) {
                e.preventDefault();

                const target =
                    document.querySelector(
                        this.getAttribute(
                            "href"
                        )
                    );

                if (target) {
                    target.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    });
                }

                document
                    .querySelectorAll(
                        ".main-nav a"
                    )
                    .forEach((link) => {
                        link.classList.remove(
                            "active"
                        );
                    });

                this.classList.add(
                    "active"
                );

                mainNav?.classList.remove(
                    "show"
                );
            }
        );
    });

/*
 * Active navigation on scroll.
 */
window.addEventListener(
    "scroll",
    () => {
        const sections =
            document.querySelectorAll(
                "section, div[id]"
            );

        const navLinks =
            document.querySelectorAll(
                ".main-nav a"
            );

        let currentSection = "";

        sections.forEach(
            (section) => {
                const top =
                    section.offsetTop;

                if (
                    window.pageYOffset >=
                    top - 60
                ) {
                    currentSection =
                        section.getAttribute(
                            "id"
                        );
                }
            }
        );

        navLinks.forEach(
            (link) => {
                link.classList.remove(
                    "active"
                );

                if (
                    link
                        .getAttribute(
                            "href"
                        )
                        .substring(1) ===
                    currentSection
                ) {
                    link.classList.add(
                        "active"
                    );
                }
            }
        );
    }
);

/*
 * Restore previous email after page reload.
 */
window.addEventListener(
    "DOMContentLoaded",
    async () => {
        const savedEmail =
            localStorage.getItem(
                "tm_email"
            );

        if (!savedEmail) {
            return;
        }

        account = {
            address: savedEmail,
        };

        const emailDisplay =
            document.getElementById(
                "emailDisplay"
            );

        if (emailDisplay) {
            emailDisplay.innerText =
                savedEmail;
        }

        await checkInbox();

        if (inboxInterval) {
            clearInterval(
                inboxInterval
            );
        }

        inboxInterval =
            setInterval(
                () => {
                    checkInbox();
                },
                15000
            );
    }
);
