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

    return {
        response,
        data,
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

async function generateAccount() {
    try {
        const username = Math.random()
            .toString(36)
            .substring(2, 10)
            .toLowerCase();

        // 获取 Cloudflare 自定义域名
        const domainsResult = await apiRequest("/domains", {
            method: "GET",
        });

        if (!domainsResult.response.ok) {
            showAlert("Failed to fetch email domain. Please try again.");
            return;
        }

        const domain = domainsResult.data?.domain;

        if (!domain) {
            showAlert("Email domain unavailable. Please try again later.");
            return;
        }

        const address = `${username}@${domain}`;

        // 在 D1 创建邮箱
        const accountResult = await apiRequest("/accounts", {
            method: "POST",
            body: JSON.stringify({
                address: address,
            }),
        });

        if (!accountResult.response.ok) {
            let message = "Failed to create temp email. Please try again.";

            if (accountResult.data?.message) {
                message = accountResult.data.message;
            }

            showAlert(message);
            return;
        }

        account = {
            address: address,
        };

        const emailDisplay = document.getElementById("emailDisplay");

        if (emailDisplay) {
            emailDisplay.innerText = address;
        }

        localStorage.setItem("tm_email", address);

        // 创建当前邮箱 Session
        const sessionResult = await apiRequest("/session", {
            method: "POST",
            body: JSON.stringify({
                address: address,
            }),
        });

        if (!sessionResult.response.ok) {
            showAlert(
                "Account created but failed to start session. Please try again."
            );
            return;
        }

        // 启动收件箱轮询
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

function getReadMessages() {
    const stored = localStorage.getItem("tm_read_messages");

    if (!stored) {
        return [];
    }

    try {
        return JSON.parse(stored);
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
            inbox.innerHTML =
                "<p>Failed to load inbox.</p>";

            showAlert("Failed to load inbox");

            return;
        }

        const inboxData = inboxResult.data || {};

        const messages = Array.isArray(
            inboxData["hydra:member"]
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

            const messageDiv =
                document.createElement("div");

            messageDiv.classList.add("message");

            const isRead =
                msg.seen ||
                readMessages.includes(String(msg.id));

            messageDiv.classList.add(
                isRead ? "read" : "unread"
            );

            messageDiv.dataset.messageId =
                String(msg.id);

            const header =
                document.createElement("div");

            header.classList.add("message-header");

            const from =
                msg.from?.address || "Unknown";

            const subject =
                msg.subject || "(No subject)";

            const intro =
                msg.intro || "";

            header.innerHTML = `
                <strong>From:</strong> ${escapeHtml(from)}<br>
                <strong>Subject:</strong> ${escapeHtml(subject)}<br>
                <strong>Time:</strong> ${escapeHtml(receivedDate)}<br>
                <strong>Preview:</strong> ${escapeHtml(intro)}
            `;

            messageDiv.appendChild(header);

            messageDiv.onclick = () => {
                showMessage(
                    String(msg.id),
                    messageDiv
                );
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

async function showMessage(id, div) {
    if (!div) {
        return;
    }

    div.classList.remove("unread");
    div.classList.add("read");

    markMessageAsRead(id);

    let bodyDiv =
        div.querySelector(".message-body");

    if (bodyDiv) {
        bodyDiv.remove();
        return;
    }

    try {
        const messageResult =
            await apiRequest(`/messages/${encodeURIComponent(id)}`, {
                method: "GET",
            });

        if (!messageResult.response.ok) {
            throw new Error(
                "Failed to fetch message"
            );
        }

        const data = messageResult.data || {};

        const body =
            data.text ||
            data.body_text ||
            "No message content.";

        const newDiv =
            document.createElement("div");

        newDiv.classList.add("message-body");

        const contentDiv =
            document.createElement("div");

        contentDiv.classList.add(
            "message-content"
        );

        contentDiv.innerHTML =
            linkify(body);

        const controlsDiv =
            document.createElement("div");

        controlsDiv.classList.add(
            "message-controls"
        );

        const closeButton =
            document.createElement("button");

        closeButton.classList.add(
            "message-close"
        );

        closeButton.innerHTML =
            '<i class="fas fa-times"></i>';

        closeButton.onclick = (event) => {
            event.stopPropagation();
            newDiv.remove();
        };

        const copyButton =
            document.createElement("button");

        copyButton.classList.add(
            "message-copy"
        );

        copyButton.innerHTML =
            '<i class="fas fa-copy"></i>';

        copyButton.onclick = (event) => {
            event.stopPropagation();

            navigator.clipboard
                .writeText(body)
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

        controlsDiv.appendChild(copyButton);
        controlsDiv.appendChild(closeButton);

        newDiv.appendChild(contentDiv);
        newDiv.appendChild(controlsDiv);

        newDiv.onclick = (event) => {
            event.stopPropagation();
        };

        div.appendChild(newDiv);
    } catch (error) {
        console.error("showMessage error:", error);

        showAlert(
            "Failed to load message content"
        );
    }
}

async function deleteAccount() {
    if (!account) {
        showAlert("No active email to delete");
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

    showAlert("Email address deleted!");
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function linkify(text) {
    const safeText = escapeHtml(text);

    return safeText.replace(
        /(https?:\/\/[^\s]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

const yearEl =
    document.getElementById("currentYear");

if (yearEl) {
    yearEl.textContent =
        new Date().getFullYear();
}

// Mobile menu
const mobileMenuBtn =
    document.querySelector(
        ".mobile-menu-btn"
    );

const mainNav =
    document.querySelector(
        ".main-nav"
    );

if (mobileMenuBtn && mainNav) {
    mobileMenuBtn.addEventListener(
        "click",
        () => {
            mainNav.classList.toggle(
                "show"
            );
        }
    );
}

// Close mobile menu
document
    .querySelectorAll(".main-nav a")
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

// Smooth scrolling
document
    .querySelectorAll('a[href^="#"]')
    .forEach((anchor) => {
        anchor.addEventListener(
            "click",
            function (event) {
                event.preventDefault();

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

// Active menu on scroll
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

// Restore previous mailbox
window.addEventListener(
    "DOMContentLoaded",
    () => {
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

        checkInbox();

        inboxInterval =
            setInterval(
                () => {
                    checkInbox();
                },
                15000
            );
    }
);
