let account = null;
let inboxInterval = null;

const API_BASE = "/api/tempmail";
const MAIL_DOMAIN = "outlook.dpdns.org";

async function apiRequest(path, options = {}) {
    const config = {
        credentials: "same-origin",
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    };

    const response = await fetch(`${API_BASE}${path}`, config);

    let data = null;

    try {
        data = await response.json();
    } catch {
        data = null;
    }

    return {
        response,
        data
    };
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

function generateUsername() {
    return Math.random()
        .toString(36)
        .substring(2, 10);
}

function generatePassword() {
    return Math.random()
        .toString(36)
        .substring(2, 14);
}

async function generateAccount() {
    const button = document.querySelector(".generate-button");

    if (button) {
        button.disabled = true;
    }

    try {
        const username = generateUsername();
        const address = `${username}@${MAIL_DOMAIN}`;
        const password = generatePassword();

        showAlert("Creating temporary email...");

        /*
         * 不再调用 /domains。
         *
         * 你的 Cloudflare /api/tempmail/domains
         * 目前返回的是单个 Domain 对象，而不是
         * Mail.tm 原始的 hydra:Collection。
         *
         * 因此这里直接使用自己的域名。
         */

        const accountResult = await apiRequest("/accounts", {
            method: "POST",
            body: JSON.stringify({
                address: address,
                password: password
            })
        });

        console.log("Create account:", accountResult.data);

        if (!accountResult.response.ok) {
            const message =
                accountResult.data?.message ||
                accountResult.data?.detail ||
                "Failed to create temp email.";

            showAlert(message);
            return;
        }

        /*
         * 创建 Mail.tm Token。
         * Cloudflare Function 会把 token 放进 HttpOnly Cookie。
         */
        const sessionResult = await apiRequest("/session", {
            method: "POST",
            body: JSON.stringify({
                address: address,
                password: password
            })
        });

        console.log("Create session:", sessionResult.data);

        if (!sessionResult.response.ok) {
            showAlert(
                "Email was created, but secure session could not be started."
            );
            return;
        }

        account = {
            address: address,
            password: password
        };

        const emailDisplay = document.getElementById("emailDisplay");

        if (emailDisplay) {
            emailDisplay.innerText = address;
        }

        localStorage.setItem("tm_email", address);

        localStorage.removeItem("tm_read_messages");

        const inbox = document.getElementById("inbox");

        if (inbox) {
            inbox.innerHTML = "<p>Loading inbox...</p>";
        }

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
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

function showAlert(message) {
    const alert = document.getElementById("alert");
    const alertMessage = document.getElementById("alertMessage");

    if (!alert || !alertMessage) {
        console.log("Alert:", message);
        return;
    }

    alertMessage.textContent = message;
    alert.classList.add("show");

    setTimeout(() => {
        closeAlert();
    }, 3000);
}

function closeAlert() {
    const alert = document.getElementById("alert");

    if (alert) {
        alert.classList.remove("show");
    }
}

function copyEmail() {
    const emailElement = document.getElementById("emailDisplay");

    const email = emailElement
        ? emailElement.innerText.trim()
        : "";

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

    if (!navigator.clipboard) {
        showAlert("Clipboard is not supported.");
        return;
    }

    navigator.clipboard
        .writeText(email)
        .then(() => {
            showAlert("Email copied to clipboard!");
        })
        .catch((error) => {
            console.error("Copy error:", error);
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

async function refreshInbox() {
    const icon = document.getElementById("inboxRefreshIcon");

    if (icon) {
        icon.classList.remove("icon-animate-refresh");

        void icon.offsetWidth;

        icon.classList.add("icon-animate-refresh");
    }

    try {
        await checkInbox();
    } finally {
        if (icon) {
            setTimeout(() => {
                icon.classList.remove("icon-animate-refresh");
            }, 800);
        }
    }
}

function getReadMessages() {
    try {
        const stored = localStorage.getItem("tm_read_messages");

        if (!stored) {
            return [];
        }

        const parsed = JSON.parse(stored);

        return Array.isArray(parsed)
            ? parsed
            : [];
    } catch (error) {
        console.error("Read messages error:", error);
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

function extractMessages(data) {
    if (!data) {
        return [];
    }

    /*
     * 标准 Mail.tm Collection
     */
    if (Array.isArray(data["hydra:member"])) {
        return data["hydra:member"];
    }

    /*
     * 兼容其他 API 返回格式
     */
    if (Array.isArray(data.member)) {
        return data.member;
    }

    if (Array.isArray(data.messages)) {
        return data.messages;
    }

    if (Array.isArray(data)) {
        return data;
    }

    return [];
}

async function checkInbox() {
    if (!account) {
        return;
    }

    const inbox = document.getElementById("inbox");

    if (!inbox) {
        return;
    }

    try {
        const inboxResult = await apiRequest("/messages", {
            method: "GET"
        });

        console.log("Inbox response:", inboxResult.data);

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
            inbox.innerHTML =
                "<p>Failed to load inbox.</p>";

            showAlert(
                inboxResult.data?.message ||
                "Failed to load inbox."
            );

            return;
        }

        const messages = extractMessages(
            inboxResult.data
        );

        inbox.innerHTML = "";

        if (messages.length === 0) {
            inbox.innerHTML =
                "<p>No messages yet.</p>";

            return;
        }

        const readMessages = getReadMessages();

        messages.forEach((msg) => {
            const messageId =
                msg.id ||
                msg["@id"] ||
                Math.random().toString(36);

            const sender =
                msg.from?.address ||
                msg.from?.name ||
                "Unknown sender";

            const subject =
                msg.subject ||
                "(No subject)";

            const intro =
                msg.intro ||
                msg.preview ||
                "";

            const createdAt =
                msg.createdAt ||
                msg.date ||
                msg.created_at;

            let receivedDate = "";

            if (createdAt) {
                const date = new Date(createdAt);

                if (!Number.isNaN(date.getTime())) {
                    receivedDate =
                        date.toLocaleString();
                }
            }

            const messageDiv =
                document.createElement("div");

            messageDiv.classList.add("message");

            const isRead =
                msg.seen === true ||
                readMessages.includes(messageId);

            messageDiv.classList.add(
                isRead ? "read" : "unread"
            );

            messageDiv.dataset.messageId =
                messageId;

            const header =
                document.createElement("div");

            header.classList.add(
                "message-header"
            );

            header.innerHTML = `
                <strong>From:</strong> ${escapeHtml(sender)}<br>
                <strong>Subject:</strong> ${escapeHtml(subject)}<br>
                <strong>Time:</strong> ${escapeHtml(receivedDate)}<br>
                <strong>Preview:</strong> ${escapeHtml(intro)}
            `;

            messageDiv.appendChild(header);

            messageDiv.onclick = () => {
                showMessage(
                    messageId,
                    messageDiv
                );
            };

            inbox.appendChild(messageDiv);
        });
    } catch (error) {
        console.error("checkInbox error:", error);

        inbox.innerHTML =
            "<p>Error loading messages.</p>";

        showAlert("Error loading inbox.");
    }
}

function getMessageBody(data) {
    if (!data) {
        return "";
    }

    /*
     * Mail.tm 通常会返回 text。
     */
    if (
        typeof data.text === "string" &&
        data.text.trim()
    ) {
        return data.text;
    }

    /*
     * 某些情况下 text 可能是空字符串，
     * 但 html 有正文。
     */
    if (
        typeof data.html === "string" &&
        data.html.trim()
    ) {
        return data.html;
    }

    /*
     * 某些 API 会返回 html 数组。
     */
    if (
        Array.isArray(data.html) &&
        data.html.length > 0
    ) {
        return data.html.join("\n");
    }

    /*
     * 兼容其他字段。
     */
    if (
        typeof data.body === "string" &&
        data.body.trim()
    ) {
        return data.body;
    }

    if (
        typeof data.content === "string" &&
        data.content.trim()
    ) {
        return data.content;
    }

    return "";
}

function linkify(text) {
    const escaped = escapeHtml(text);

    return escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

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
        const messageResult =
            await apiRequest(
                `/messages/${encodeURIComponent(id)}`,
                {
                    method: "GET"
                }
            );

        console.log(
            "Message detail:",
            messageResult.data
        );

        if (!messageResult.response.ok) {
            throw new Error(
                messageResult.data?.message ||
                "Failed to fetch message"
            );
        }

        const data = messageResult.data;

        const body = getMessageBody(data);

        const newDiv =
            document.createElement("div");

        newDiv.classList.add(
            "message-body"
        );

        const contentDiv =
            document.createElement("div");

        contentDiv.classList.add(
            "message-content"
        );

        if (body) {
            contentDiv.innerHTML =
                linkify(body);
        } else {
            contentDiv.innerHTML =
                "<p>No message content.</p>";
        }

        const controlsDiv =
            document.createElement("div");

        controlsDiv.classList.add(
            "message-controls"
        );

        const copyButton =
            document.createElement("button");

        copyButton.classList.add(
            "message-copy"
        );

        copyButton.innerHTML =
            '<i class="fas fa-copy"></i>';

        copyButton.title =
            "Copy message";

        copyButton.onclick = (event) => {
            event.stopPropagation();

            if (!body) {
                showAlert(
                    "There is no message content to copy."
                );

                return;
            }

            if (!navigator.clipboard) {
                showAlert(
                    "Clipboard is not supported."
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

        const closeButton =
            document.createElement("button");

        closeButton.classList.add(
            "message-close"
        );

        closeButton.innerHTML =
            '<i class="fas fa-times"></i>';

        closeButton.title =
            "Close message";

        closeButton.onclick = (event) => {
            event.stopPropagation();
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

        newDiv.onclick = (event) => {
            event.stopPropagation();
        };

        div.appendChild(newDiv);
    } catch (error) {
        console.error(
            "showMessage error:",
            error
        );

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
        await apiRequest("/logout", {
            method: "POST"
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

    resetSessionState(true);

    showAlert(
        "Email address deleted!"
    );
}

function setupMobileMenu() {
    const mobileMenuBtn =
        document.querySelector(
            ".mobile-menu-btn"
        );

    const mainNav =
        document.querySelector(
            ".main-nav"
        );

    if (!mobileMenuBtn || !mainNav) {
        return;
    }

    mobileMenuBtn.addEventListener(
        "click",
        () => {
            mainNav.classList.toggle(
                "show"
            );
        }
    );

    document
        .querySelectorAll(".main-nav a")
        .forEach((link) => {
            link.addEventListener(
                "click",
                () => {
                    mainNav.classList.remove(
                        "show"
                    );
                }
            );
        });
}

function setupSmoothScroll() {
    document
        .querySelectorAll(
            'a[href^="#"]'
        )
        .forEach((anchor) => {
            anchor.addEventListener(
                "click",
                function (event) {
                    event.preventDefault();

                    const selector =
                        this.getAttribute(
                            "href"
                        );

                    const target =
                        document.querySelector(
                            selector
                        );

                    if (target) {
                        target.scrollIntoView({
                            behavior: "smooth",
                            block: "start"
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
                }
            );
        });
}

function setupScrollNavigation() {
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
                        const id =
                            section.getAttribute(
                                "id"
                            );

                        if (id) {
                            currentSection =
                                id;
                        }
                    }
                }
            );

            navLinks.forEach(
                (link) => {
                    link.classList.remove(
                        "active"
                    );

                    const href =
                        link.getAttribute(
                            "href"
                        );

                    if (
                        href &&
                        href.startsWith("#") &&
                        href.substring(1) ===
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
}

function restoreSession() {
    const savedEmail =
        localStorage.getItem(
            "tm_email"
        );

    if (!savedEmail) {
        return;
    }

    /*
     * 注意：
     * 真正的 token 在 HttpOnly Cookie 中，
     * JavaScript 无法读取。
     *
     * 这里先恢复 UI，然后让 checkInbox()
     * 判断 Cookie 是否仍然有效。
     */
    account = {
        address: savedEmail
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

    if (inboxInterval) {
        clearInterval(inboxInterval);
    }

    inboxInterval = setInterval(
        () => {
            checkInbox();
        },
        15000
    );
}

document.addEventListener(
    "DOMContentLoaded",
    () => {
        const yearEl =
            document.getElementById(
                "currentYear"
            );

        if (yearEl) {
            yearEl.textContent =
                new Date().getFullYear();
        }

        setupMobileMenu();
        setupSmoothScroll();
        setupScrollNavigation();

        restoreSession();
    }
);
