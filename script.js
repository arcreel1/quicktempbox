let account = null;
let inboxInterval = null;

const API_BASE = "/api/tempmail";
const EMAIL_DOMAIN = "outlook.dpdns.org";

/**
 * API 请求
 */
async function apiRequest(path, options = {}) {
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            credentials: "same-origin",
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        });

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
    } catch (error) {
        console.error("API request error:", error);

        return {
            response: {
                ok: false,
                status: 0
            },
            data: null
        };
    }
}

/**
 * 重置 Session
 */
function resetSessionState(clearEmailDisplay = true) {
    account = null;

    localStorage.removeItem("tm_email");
    localStorage.removeItem("tm_password");
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
 * 生成随机字符串
 */
function randomString(length = 10) {
    return Math.random()
        .toString(36)
        .substring(2, 2 + length);
}

/**
 * 创建临时邮箱
 */
async function generateAccount() {
    try {
        showAlert("Creating temporary email...");

        /*
         * 直接使用自己的域名
         * 不再调用 /domains
         */
        const username =
            randomString(8) +
            randomString(4);

        const address = `${username}@${EMAIL_DOMAIN}`;

        const password =
            randomString(10) +
            randomString(4);

        console.log("Creating account:", address);

        /*
         * 创建 Mail.tm 账户
         */
        const accountResult = await apiRequest("/accounts", {
            method: "POST",
            body: JSON.stringify({
                address,
                password
            })
        });

        console.log("Account result:", accountResult);

        if (!accountResult.response.ok) {
            console.error(
                "Account creation failed:",
                accountResult.data
            );

            const message =
                accountResult.data?.message ||
                accountResult.data?.detail ||
                "Failed to create temp email.";

            showAlert(message);
            return;
        }

        /*
         * 保存账户信息
         */
        account = {
            address,
            password
        };

        localStorage.setItem("tm_email", address);
        localStorage.setItem("tm_password", password);

        const emailDisplay =
            document.getElementById("emailDisplay");

        if (emailDisplay) {
            emailDisplay.innerText = address;
        }

        /*
         * 创建服务器 Session
         */
        const sessionResult = await apiRequest("/session", {
            method: "POST",
            body: JSON.stringify({
                address,
                password
            })
        });

        console.log("Session result:", sessionResult);

        if (!sessionResult.response.ok) {
            console.error(
                "Session creation failed:",
                sessionResult.data
            );

            showAlert(
                sessionResult.data?.message ||
                "Account created, but session could not be started."
            );

            return;
        }

        /*
         * 清除旧轮询
         */
        if (inboxInterval) {
            clearInterval(inboxInterval);
        }

        /*
         * 立即检查收件箱
         */
        await checkInbox();

        /*
         * 每 15 秒自动刷新
         */
        inboxInterval = setInterval(() => {
            checkInbox();
        }, 15000);

        showAlert("Email account created successfully!");

    } catch (error) {
        console.error(
            "generateAccount error:",
            error
        );

        showAlert(
            "An error occurred. Please try again."
        );
    }
}

/**
 * Alert
 */
function showAlert(message) {
    const alert =
        document.getElementById("alert");

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

/**
 * 关闭 Alert
 */
function closeAlert() {
    const alert =
        document.getElementById("alert");

    if (alert) {
        alert.classList.remove("show");
    }
}

/**
 * 复制邮箱
 */
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
        icon.classList.remove(
            "icon-animate-copy"
        );

        void icon.offsetWidth;

        icon.classList.add(
            "icon-animate-copy"
        );
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
        .catch(() => {
            showAlert("Failed to copy email.");
        });
}

/**
 * 刷新图标动画
 */
function triggerSpin(icon) {
    if (!icon) {
        return;
    }

    icon.classList.remove("animate-spin");

    void icon.offsetWidth;

    icon.classList.add("animate-spin");
}

/**
 * 刷新收件箱
 */
async function refreshInbox() {
    const icon =
        document.getElementById(
            "inboxRefreshIcon"
        );

    if (icon) {
        icon.classList.remove(
            "icon-animate-refresh"
        );

        void icon.offsetWidth;

        icon.classList.add(
            "icon-animate-refresh"
        );
    }

    await checkInbox();

    if (icon) {
        setTimeout(() => {
            icon.classList.remove(
                "icon-animate-refresh"
            );
        }, 800);
    }
}

/**
 * 已读邮件
 */
function getReadMessages() {
    try {
        const stored =
            localStorage.getItem(
                "tm_read_messages"
            );

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

/**
 * 标记邮件为已读
 */
function markMessageAsRead(messageId) {
    const readMessages =
        getReadMessages();

    if (!readMessages.includes(messageId)) {
        readMessages.push(messageId);

        localStorage.setItem(
            "tm_read_messages",
            JSON.stringify(readMessages)
        );
    }
}

/**
 * 转义 HTML
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
 * 将 URL 转换为链接
 */
function linkify(text) {
    const escaped =
        escapeHtml(text);

    return escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/**
 * 获取邮件正文
 *
 * Mail.tm 可能返回：
 * text
 * html
 * intro
 */
function getMessageBody(data) {
    if (!data) {
        return "No message content.";
    }

    /*
     * 优先使用纯文本
     */
    if (
        typeof data.text === "string" &&
        data.text.trim()
    ) {
        return data.text;
    }

    /*
     * HTML 可能是字符串，也可能是数组
     */
    if (data.html) {
        if (Array.isArray(data.html)) {
            const htmlText =
                data.html
                    .filter(Boolean)
                    .join("\n");

            if (htmlText.trim()) {
                return htmlText;
            }
        }

        if (
            typeof data.html === "string" &&
            data.html.trim()
        ) {
            return data.html;
        }
    }

    /*
     * 最后尝试 intro
     */
    if (
        typeof data.intro === "string" &&
        data.intro.trim()
    ) {
        return data.intro;
    }

    return "No message content.";
}

/**
 * 检查收件箱
 */
async function checkInbox() {
    if (!account) {
        return;
    }

    const inbox =
        document.getElementById("inbox");

    if (!inbox) {
        return;
    }

    inbox.innerHTML =
        "<p>Loading...</p>";

    try {
        const inboxResult =
            await apiRequest(
                "/messages",
                {
                    method: "GET"
                }
            );

        console.log(
            "Messages result:",
            inboxResult
        );

        /*
         * Session 过期
         */
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

        /*
         * API 错误
         */
        if (!inboxResult.response.ok) {
            console.error(
                "Inbox error:",
                inboxResult.data
            );

            inbox.innerHTML =
                "<p>Failed to load inbox.</p>";

            showAlert(
                inboxResult.data?.message ||
                "Failed to load inbox."
            );

            return;
        }

        const inboxData =
            inboxResult.data || {};

        /*
         * Mail.tm 标准格式
         */
        let messages =
            inboxData["hydra:member"];

        /*
         * 兼容其他格式
         */
        if (!Array.isArray(messages)) {
            messages =
                inboxData.member;

        }

        if (!Array.isArray(messages)) {
            messages = [];
        }

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

            const messageId =
                msg.id || "";

            const isRead =
                Boolean(msg.seen) ||
                readMessages.includes(messageId);

            messageDiv.classList.add(
                isRead
                    ? "read"
                    : "unread"
            );

            messageDiv.dataset.messageId =
                messageId;

            const receivedDate =
                msg.createdAt
                    ? new Date(
                        msg.createdAt
                    ).toLocaleString()
                    : "";

            const fromAddress =
                msg.from?.address ||
                msg.from?.name ||
                "Unknown sender";

            const subject =
                msg.subject ||
                "(No subject)";

            const intro =
                msg.intro ||
                "";

            const header =
                document.createElement("div");

            header.classList.add(
                "message-header"
            );

            header.innerHTML = `
                <strong>From:</strong> ${escapeHtml(fromAddress)}<br>
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

/**
 * 显示邮件正文
 */
async function showMessage(id, div) {
    if (!div || !id) {
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
     * 已经打开则关闭
     */
    const existingBody =
        div.querySelector(
            ".message-body"
        );

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
            messageResult
        );

        if (
            messageResult.response.status === 401
        ) {
            resetSessionState(false);

            showAlert(
                "Session expired. Please generate a new email."
            );

            return;
        }

        if (!messageResult.response.ok) {
            throw new Error(
                "Failed to fetch message"
            );
        }

        const data =
            messageResult.data || {};

        console.log(
            "Message data:",
            data
        );

        const body =
            getMessageBody(data);

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

        /*
         * 如果存在 HTML 正文：
         * 使用浏览器 DOMParser 清除危险元素
         */
        if (
            data.html &&
            !data.text
        ) {
            let htmlContent = "";

            if (Array.isArray(data.html)) {
                htmlContent =
                    data.html
                        .filter(Boolean)
                        .join("\n");
            } else {
                htmlContent =
                    String(data.html);
            }

            const parser =
                new DOMParser();

            const parsed =
                parser.parseFromString(
                    htmlContent,
                    "text/html"
                );

            /*
             * 删除危险标签
             */
            parsed
                .querySelectorAll(
                    "script, iframe, object, embed, form"
                )
                .forEach((element) => {
                    element.remove();
                });

            /*
             * 删除危险事件属性
             */
            parsed
                .querySelectorAll("*")
                .forEach((element) => {
                    [...element.attributes]
                        .forEach((attribute) => {
                            if (
                                attribute.name
                                    .toLowerCase()
                                    .startsWith("on")
                            ) {
                                element.removeAttribute(
                                    attribute.name
                                );
                            }
                        });
                });

            contentDiv.innerHTML =
                parsed.body.innerHTML;

        } else {
            /*
             * 纯文本安全显示
             */
            contentDiv.innerHTML =
                linkify(body);
        }

        const controlsDiv =
            document.createElement("div");

        controlsDiv.classList.add(
            "message-controls"
        );

        /*
         * 复制按钮
         */
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
         * 关闭按钮
         */
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

        div.appendChild(
            newDiv
        );

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

/**
 * 删除/退出当前邮箱
 */
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
                method: "POST"
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

    const emailDisplay =
        document.getElementById(
            "emailDisplay"
        );

    if (emailDisplay) {
        emailDisplay.innerText =
            "---";
    }

    resetSessionState(false);

    showAlert(
        "Email address deleted!"
    );
}

/**
 * 页面年份
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
 * 手机菜单
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
 * 点击导航关闭菜单
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
 * 平滑滚动
 */
document
    .querySelectorAll(
        'a[href^="#"]'
    )
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

                mainNav?.classList.remove(
                    "show"
                );
            }
        );
    });

/**
 * 滚动更新导航
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

        let currentSection =
            "";

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

/**
 * 刷新图标点击动画
 */
const emailIcon =
    document.getElementById(
        "emailRefreshIcon"
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

const inboxIcon =
    document.getElementById(
        "inboxRefreshIcon"
    );

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

/**
 * 页面加载
 */
window.addEventListener(
    "DOMContentLoaded",
    () => {
        const savedEmail =
            localStorage.getItem(
                "tm_email"
            );

        const savedPassword =
            localStorage.getItem(
                "tm_password"
            );

        if (
            savedEmail &&
            savedPassword
        ) {
            account = {
                address: savedEmail,
                password: savedPassword
            };

            const emailDisplay =
                document.getElementById(
                    "emailDisplay"
                );

            if (emailDisplay) {
                emailDisplay.innerText =
                    savedEmail;
            }

            /*
             * Session Cookie 仍然有效时，
             * 直接恢复收件箱
             */
            checkInbox();

            inboxInterval =
                setInterval(
                    () => {
                        checkInbox();
                    },
                    15000
                );
        }
    }
);
