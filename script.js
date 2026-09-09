let account = null;
let inboxInterval = null;

const API_BASE = "/api/tempmail";

async function apiRequest(path, options = {}) {
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

    return { response, data };
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

/**
 * Generate temporary email account
 */
async function generateAccount() {
    try {
        const username = Math.random()
            .toString(36)
            .substring(2, 10);

        const domainsResult = await apiRequest("/domains", {
            method: "GET",
        });

        if (!domainsResult.response.ok) {
            showAlert("Failed to fetch email domains. Please try again.");
            return;
        }

        const domainData = domainsResult.data;

        if (
            !domainData ||
            !Array.isArray(domainData["hydra:member"]) ||
            domainData["hydra:member"].length === 0
        ) {
            showAlert("No email domains available. Please try again later.");
            return;
        }

        /*
         * Your Mail.tm API currently reports
         * outlook.dpdns.org as an active domain.
         */
        const domain = "outlook.dpdns.org";

        const address = `${username}@${domain}`;

        const password = Math.random()
            .toString(36)
            .substring(2, 12);

        const accountResult = await apiRequest("/accounts", {
            method: "POST",
            body: JSON.stringify({
                address,
                password,
            }),
        });

        if (!accountResult.response.ok) {
            console.error("Account creation failed:", accountResult.data);

            showAlert("Failed to create temp email. Please try again.");
            return;
        }

        account = {
            address,
            password,
        };

        const emailDisplay = document.getElementById("emailDisplay");

        if (emailDisplay) {
            emailDisplay.innerText = address;
        }

        localStorage.setItem("tm_email", address);

        /*
         * Create secure server session.
         * The token is stored in an HttpOnly cookie
         * by the Cloudflare/Netlify function.
         */
        const sessionResult = await apiRequest("/session", {
            method: "POST",
            body: JSON.stringify({
                address,
                password,
            }),
        });

        if (!sessionResult.response.ok) {
            console.error("Session creation failed:", sessionResult.data);

            showAlert(
                "Account created but failed to start secure session. Please try again."
            );

            return;
        }

        if (inboxInterval) {
            clearInterval(inboxInterval);
        }

        await checkInbox();

        inboxInterval = setInterval(checkInbox, 15000);

        showAlert("Email account created successfully!");

    } catch (error) {
        console.error("generateAccount error:", error);

        showAlert("An error occurred. Please try again.");
    }
}

/**
 * Alert
 */
function showAlert(message) {
    const alert = document.getElementById("alert");
    const alertMessage = document.getElementById("alertMessage");

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

/**
 * Copy email
 */
function copyEmail() {
    const email = document
        .getElementById("emailDisplay")
        ?.innerText;

    if (!email || email === "---") {
        showAlert("Please generate an email first!");
        return;
    }

    const copyIcons = document.querySelectorAll(".fa-copy");

    copyIcons.forEach((icon) => {
        icon.classList.remove("icon-animate-copy");

        void icon.offsetWidth;

        icon.classList.add("icon-animate-copy");
    });

    navigator.clipboard
        .writeText(email)
        .then(() => {
            showAlert("Email copied to clipboard!");
        })
        .catch(() => {
            showAlert("Failed to copy email");
        });
}

/**
 * Refresh icon
 */
const emailIcon = document.getElementById("emailRefreshIcon");

if (emailIcon) {
    emailIcon.addEventListener("click", () => {
        triggerSpin(emailIcon);
    });
}

const inboxIcon = document.getElementById("inboxRefreshIcon");

if (inboxIcon) {
    inboxIcon.addEventListener("click", () => {
        triggerSpin(inboxIcon);
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

/**
 * Refresh inbox
 */
function refreshInbox() {
    const icon = document.getElementById("inboxRefreshIcon");

    if (!icon) {
        return;
    }

    icon.classList.remove("icon-animate-refresh");

    void icon.offsetWidth;

    icon.classList.add("icon-animate-refresh");

    checkInbox().then(() => {
        setTimeout(() => {
            icon.classList.remove("icon-animate-refresh");
        }, 800);
    });
}

/**
 * Read message tracking
 */
function getReadMessages() {
    try {
        const stored = localStorage.getItem("tm_read_messages");

        return stored ? JSON.parse(stored) : [];
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

/**
 * Escape HTML
 *
 * This prevents email content from injecting scripts
 * into your website.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Convert URLs to clickable links
 */
function linkify(text) {
    const escaped = escapeHtml(text);

    return escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/**
 * Get readable message preview
 */
function getMessagePreview(message) {
    if (!message) {
        return "";
    }

    if (message.intro) {
        return message.intro;
    }

    if (message.text) {
        return String(message.text)
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 200);
    }

    if (message.html) {
        return String(message.html)
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 200);
    }

    return "";
}

/**
 * Load inbox
 */
async function checkInbox() {
    if (!account) {
        return;
    }

    const inbox = document.getElementById("inbox");

    if (!inbox) {
        return;
    }

    inbox.innerHTML = "<p>Loading...</p>";

    try {
        const inboxResult = await apiRequest("/messages", {
            method: "GET",
        });

        if (inboxResult.response.status === 401) {
            resetSessionState(false);

            inbox.innerHTML =
                "<p>Session expired. Generate a new email.</p>";

            showAlert(
                "Session expired. Please generate a new email."
            );

            return;
        }

        if (!inboxResult.response.ok) {
            console.error(
                "Inbox request failed:",
                inboxResult.data
            );

            inbox.innerHTML =
                "<p>Failed to load inbox.</p>";

            showAlert("Failed to load inbox");

            return;
        }

        const inboxData = inboxResult.data;

        const messages = Array.isArray(
            inboxData?.["hydra:member"]
        )
            ? inboxData["hydra:member"]
            : [];

        inbox.innerHTML = "";

        if (messages.length === 0) {
            inbox.innerHTML = "<p>No messages yet.</p>";
            return;
        }

        const readMessages = getReadMessages();

        for (const msg of messages) {
            const receivedDate = msg.createdAt
                ? new Date(msg.createdAt).toLocaleString()
                : "";

            const messageDiv = document.createElement("div");

            messageDiv.classList.add("message");

            const isRead =
                msg.seen ||
                readMessages.includes(msg.id);

            messageDiv.classList.add(
                isRead ? "read" : "unread"
            );

            messageDiv.dataset.messageId = msg.id;

            const header = document.createElement("div");

            header.classList.add("message-header");

            const fromAddress =
                msg.from?.address ||
                msg.from?.name ||
                "Unknown sender";

            const subject =
                msg.subject ||
                "(No subject)";

            const preview =
                getMessagePreview(msg) ||
                "(No preview available)";

            header.innerHTML = `
                <strong>From:</strong> ${escapeHtml(fromAddress)}<br>
                <strong>Subject:</strong> ${escapeHtml(subject)}<br>
                <strong>Time:</strong> ${escapeHtml(receivedDate)}<br>
                <strong>Preview:</strong> ${escapeHtml(preview)}
            `;

            messageDiv.appendChild(header);

            messageDiv.onclick = () => {
                showMessage(msg.id, messageDiv);
            };

            inbox.appendChild(messageDiv);
        }

    } catch (error) {
        console.error("checkInbox error:", error);

        inbox.innerHTML =
            "<p>Error loading messages.</p>";

        showAlert("Error loading inbox");
    }
}

/**
 * Display full email
 */
async function showMessage(id, div) {
    if (!div) {
        return;
    }

    div.classList.remove("unread");
    div.classList.add("read");

    markMessageAsRead(id);

    const existingBody =
        div.querySelector(".message-body");

    if (existingBody) {
        existingBody.remove();
        return;
    }

    try {
        const messageResult = await apiRequest(
            `/messages/${encodeURIComponent(id)}`,
            {
                method: "GET",
            }
        );

        if (!messageResult.response.ok) {
            console.error(
                "Message request failed:",
                messageResult.data
            );

            throw new Error(
                "Failed to fetch message"
            );
        }

        const data = messageResult.data;

        console.log(
            "Full Mail.tm message:",
            data
        );

        /*
         * Mail.tm may provide:
         *
         * data.text
         * data.html
         *
         * Different emails may contain one or both.
         */
        const textBody =
            typeof data?.text === "string"
                ? data.text.trim()
                : "";

        const htmlBody =
            typeof data?.html === "string"
                ? data.html.trim()
                : "";

        const newDiv =
            document.createElement("div");

        newDiv.classList.add("message-body");

        const contentDiv =
            document.createElement("div");

        contentDiv.classList.add(
            "message-content"
        );

        /*
         * Prefer plain text because it is safer
         * and easier to display correctly.
         *
         * If plain text is unavailable, use the HTML
         * version after sanitizing it.
         */
        if (textBody) {
            contentDiv.innerHTML =
                linkify(textBody)
                    .replace(/\n/g, "<br>");
        } else if (htmlBody) {
            /*
             * Remove dangerous elements and attributes.
             * This is a basic client-side sanitizer.
             */
            const parser =
                new DOMParser();

            const parsed =
                parser.parseFromString(
                    htmlBody,
                    "text/html"
                );

            parsed
                .querySelectorAll(
                    "script, iframe, object, embed, form, base, meta, link"
                )
                .forEach((el) => el.remove());

            parsed
                .querySelectorAll("*")
                .forEach((el) => {
                    [...el.attributes].forEach(
                        (attr) => {
                            const name =
                                attr.name.toLowerCase();

                            const value =
                                attr.value.trim();

                            if (
                                name.startsWith("on") ||
                                name === "srcdoc"
                            ) {
                                el.removeAttribute(
                                    attr.name
                                );
                            }

                            if (
                                (name === "href" ||
                                    name === "src") &&
                                value
                                    .toLowerCase()
                                    .startsWith(
                                        "javascript:"
                                    )
                            ) {
                                el.removeAttribute(
                                    attr.name
                                );
                            }
                        }
                    );
                });

            contentDiv.innerHTML =
                parsed.body.innerHTML;
        } else if (data?.intro) {
            contentDiv.innerHTML =
                linkify(String(data.intro))
                    .replace(/\n/g, "<br>");
        } else {
            contentDiv.innerHTML =
                "<p>No message content.</p>";
        }

        const controlsDiv =
            document.createElement("div");

        controlsDiv.classList.add(
            "message-controls"
        );

        /*
         * Copy button
         */
        const copyButton =
            document.createElement("button");

        copyButton.classList.add(
            "message-copy"
        );

        copyButton.title =
            "Copy message";

        copyButton.innerHTML =
            '<i class="fas fa-copy"></i>';

        copyButton.onclick = (e) => {
            e.stopPropagation();

            const copyText =
                textBody ||
                data?.intro ||
                htmlBody.replace(
                    /<[^>]+>/g,
                    " "
                );

            navigator.clipboard
                .writeText(
                    String(copyText)
                )
                .then(() => {
                    showAlert(
                        "Message content copied!"
                    );
                })
                .catch(() => {
                    showAlert(
                        "Failed to copy"
                    );
                });
        };

        /*
         * Close button
         */
        const closeButton =
            document.createElement("button");

        closeButton.classList.add(
            "message-close"
        );

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

        div.appendChild(newDiv);

    } catch (error) {
        console.error(
            "showMessage error:",
            error
        );

        showAlert(
            "Failed to load message content"
        );
    }
}

/**
 * Delete / logout current account
 */
async function deleteAccount() {
    if (!account) {
        showAlert(
            "No active email to delete"
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
        await apiRequest("/logout", {
            method: "POST",
        });
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

    const emailDisplay =
        document.getElementById(
            "emailDisplay"
        );

    if (emailDisplay) {
        emailDisplay.innerText = "---";
    }

    resetSessionState(false);

    showAlert(
        "Email address deleted!"
    );
}

/**
 * Current year
 */
const yearEl =
    document.getElementById(
        "currentYear"
    );

if (yearEl) {
    yearEl.textContent =
        new Date().getFullYear();
}

/**
 * Mobile menu
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

/**
 * Close mobile menu
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

/**
 * Smooth scrolling
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
                    target.scrollIntoView(
                        {
                            behavior: "smooth",
                            block: "start",
                        }
                    );
                }

                document
                    .querySelectorAll(
                        ".main-nav a"
                    )
                    .forEach((l) => {
                        l.classList.remove(
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

/**
 * Active menu on scroll
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
                        ?.substring(1) ===
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

/**
 * Restore previous session
 */
window.addEventListener(
    "DOMContentLoaded",
    () => {
        const savedEmail =
            localStorage.getItem(
                "tm_email"
            );

        if (savedEmail) {
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

            checkInbox();

            inboxInterval =
                setInterval(
                    checkInbox,
                    15000
                );
        }
    }
);
