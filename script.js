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
        if (emailDisplay) emailDisplay.innerText = "---";
    }
}

async function generateAccount() {
    try {
        const username = Math.random().toString(36).substring(2, 10);

        // Get domains through serverless proxy
        const domainsResult = await apiRequest("/domains", { method: "GET" });
        if (!domainsResult.response.ok) { showAlert("Failed to fetch email domains. Please try again."); return; }

        const domainData = domainsResult.data;
        if (!domainData["hydra:member"] || domainData["hydra:member"].length === 0) {
            showAlert("No email domains available. Please try again later."); return;
        }

        const domain = "outlook.dpdns.org";
        const address = `${username}@${domain}`;
        const password = Math.random().toString(36).substring(2, 12);

        // Create account through serverless proxy
        const accountResult = await apiRequest("/accounts", {
            method: "POST",
            body: JSON.stringify({ address, password }),
        });

        if (!accountResult.response.ok) { showAlert("Failed to create temp email. Please try again."); return; }

        account = { address };
        const emailDisplay = document.getElementById("emailDisplay");
        if (emailDisplay) emailDisplay.innerText = address;

        localStorage.setItem("tm_email", address);

        // Create secure server session (token is stored in HttpOnly cookie by function)
        const sessionResult = await apiRequest("/session", {
            method: "POST",
            body: JSON.stringify({ address, password }),
        });

        if (!sessionResult.response.ok) {
            showAlert("Account created but failed to start secure session. Please try again.");
            return;
        }

        // Start polling inbox
        if (inboxInterval) clearInterval(inboxInterval);
        checkInbox();
        inboxInterval = setInterval(checkInbox, 15000);

        showAlert("Email account created successfully!");
    } catch (error) {
        showAlert("An error occurred. Please try again.");
        console.error(error);
    }
}

function showAlert(message) {
    const alert = document.getElementById("alert");
    const alertMessage = document.getElementById("alertMessage");
    if (alert && alertMessage) {
        alertMessage.textContent = message;
        alert.classList.add("show");
        setTimeout(() => { closeAlert(); }, 3000);
    } else {
        console.log("Alert:", message);
    }
}

function closeAlert() {
    const alert = document.getElementById("alert");
    if (alert) alert.classList.remove("show");
}

function copyEmail() {
    const email = document.getElementById("emailDisplay")?.innerText;
    if (!email || email === "---") { showAlert("Please generate an email first!"); return; }

    const copyIcons = document.querySelectorAll(".fa-copy");
    copyIcons.forEach((icon) => {
        icon.classList.remove("icon-animate-copy");
        void icon.offsetWidth;
        icon.classList.add("icon-animate-copy");
    });

    navigator.clipboard.writeText(email)
        .then(() => showAlert("Email copied to clipboard!"))
        .catch(() => showAlert("Failed to copy email"));
}

// Email & inbox spin icons (safe)
const emailIcon = document.getElementById("emailRefreshIcon");
if (emailIcon) emailIcon.addEventListener("click", () => triggerSpin(emailIcon));

const inboxIcon = document.getElementById("inboxRefreshIcon");
if (inboxIcon) inboxIcon.addEventListener("click", () => triggerSpin(inboxIcon));

function triggerSpin(icon) {
    if (!icon) return;
    icon.classList.remove("animate-spin");
    void icon.offsetWidth;
    icon.classList.add("animate-spin");
}

function refreshInbox() {
    const icon = document.getElementById("inboxRefreshIcon");
    if (!icon) return;

    icon.classList.remove("icon-animate-refresh");
    void icon.offsetWidth;
    icon.classList.add("icon-animate-refresh");

    checkInbox().then(() => {
        setTimeout(() => icon.classList.remove("icon-animate-refresh"), 800);
    });
}

// Read message tracking
function getReadMessages() {
    const stored = localStorage.getItem("tm_read_messages");
    return stored ? JSON.parse(stored) : [];
}

function markMessageAsRead(messageId) {
    const readMessages = getReadMessages();
    if (!readMessages.includes(messageId)) {
        readMessages.push(messageId);
        localStorage.setItem("tm_read_messages", JSON.stringify(readMessages));
    }
}

async function checkInbox() {
    if (!account) return;
    const inbox = document.getElementById("inbox");
    if (!inbox) return;

    inbox.innerHTML = "<p>Loading...</p>";

    try {
        const inboxResult = await apiRequest("/messages", { method: "GET" });
        if (inboxResult.response.status === 401) {
            resetSessionState(false);
            inbox.innerHTML = "<p>Session expired. Generate a new email.</p>";
            showAlert("Session expired. Please generate a new email.");
            return;
        }
        if (!inboxResult.response.ok) { inbox.innerHTML = "<p>Failed to load inbox.</p>"; showAlert("Failed to load inbox"); return; }

        const inboxData = inboxResult.data;
        const messages = inboxData["hydra:member"];
        inbox.innerHTML = "";

        if (messages.length === 0) { inbox.innerHTML = "<p>No messages yet.</p>"; return; }

        const readMessages = getReadMessages();
        for (let msg of messages) {
            const receivedDate = new Date(msg.createdAt).toLocaleString();
            const messageDiv = document.createElement("div");
            messageDiv.classList.add("message");
            const isRead = msg.hasAttachments || msg.seen || readMessages.includes(msg.id);
            messageDiv.classList.add(isRead ? "read" : "unread");
            messageDiv.dataset.messageId = msg.id;

            const header = document.createElement("div");
            header.classList.add("message-header");
            header.innerHTML = `
                <strong>From:</strong> ${msg.from.address}<br>
                <strong>Subject:</strong> ${msg.subject}<br>
                <strong>Time:</strong> ${receivedDate}<br>
                <strong>Preview:</strong> ${msg.intro}
            `;
            messageDiv.appendChild(header);
            messageDiv.onclick = () => showMessage(msg.id, messageDiv);
            inbox.appendChild(messageDiv);
        }
    } catch (error) {
        console.error(error);
        inbox.innerHTML = "<p>Error loading messages.</p>";
        showAlert("Error loading inbox");
    }
}

async function showMessage(id, div) {
    if (!div) return;
    div.classList.remove("unread"); div.classList.add("read");
    markMessageAsRead(id);

    let bodyDiv = div.querySelector(".message-body");
    if (bodyDiv) { bodyDiv.remove(); return; }

    try {
        const messageResult = await apiRequest(`/messages/${id}`, { method: "GET" });
        if (!messageResult.response.ok) throw new Error("Failed to fetch message");

        const data = messageResult.data;
        const body = data.text || "No message content.";

        const newDiv = document.createElement("div");
        newDiv.classList.add("message-body");

        const contentDiv = document.createElement("div");
        contentDiv.classList.add("message-content");
        contentDiv.innerHTML = linkify(body);

        const controlsDiv = document.createElement("div");
        controlsDiv.classList.add("message-controls");

        const closeButton = document.createElement("button");
        closeButton.classList.add("message-close");
        closeButton.innerHTML = '<i class="fas fa-times"></i>';
        closeButton.onclick = (e) => { e.stopPropagation(); newDiv.remove(); };

        const copyButton = document.createElement("button");
        copyButton.classList.add("message-copy");
        copyButton.innerHTML = '<i class="fas fa-copy"></i>';
        copyButton.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(body).then(() => showAlert("Message content copied!")).catch(() => showAlert("Failed to copy"));
        };

        controlsDiv.appendChild(copyButton);
        controlsDiv.appendChild(closeButton);
        newDiv.appendChild(contentDiv);
        newDiv.appendChild(controlsDiv);
        newDiv.onclick = (e) => e.stopPropagation();

        div.appendChild(newDiv);
    } catch (error) {
        console.error(error);
        showAlert("Failed to load message content");
    }
}

async function deleteAccount() {
    if (!account) { showAlert("No active email to delete"); return; }
    const deleteIcon = document.querySelector(".action-button.delete i");
    if (deleteIcon) { deleteIcon.classList.remove("icon-animate-delete"); void deleteIcon.offsetWidth; deleteIcon.classList.add("icon-animate-delete"); }

    try {
        await apiRequest("/logout", { method: "POST" });
    } catch (error) {
        console.error("Logout error", error);
    }

    const inbox = document.getElementById("inbox");
    if (inbox) inbox.innerHTML = "<p>No messages yet.</p>";

    const emailDisplay = document.getElementById("emailDisplay");
    if (emailDisplay) emailDisplay.innerText = "---";

    resetSessionState(false);

    showAlert("Email address deleted!");
}

const yearEl = document.getElementById("currentYear");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Mobile menu toggle
const mobileMenuBtn = document.querySelector(".mobile-menu-btn");
const mainNav = document.querySelector(".main-nav");
if (mobileMenuBtn && mainNav) {
    mobileMenuBtn.addEventListener("click", () => mainNav.classList.toggle("show"));
}

// Close mobile menu when clicking a nav link
document.querySelectorAll(".main-nav a").forEach(link => {
    link.addEventListener("click", () => { mainNav?.classList.remove("show"); });
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener("click", function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute("href"));
        if (target) { target.scrollIntoView({ behavior: "smooth", block: "start" }); }
        document.querySelectorAll(".main-nav a").forEach(l => l.classList.remove("active"));
        this.classList.add("active");
        mainNav?.classList.remove("show");
    });
});

// Update active menu on scroll
window.addEventListener("scroll", () => {
    const sections = document.querySelectorAll("section, div[id]");
    const navLinks = document.querySelectorAll(".main-nav a");
    let currentSection = "";

    sections.forEach(section => {
        const top = section.offsetTop;
        const height = section.clientHeight;
        if (window.pageYOffset >= top - 60) currentSection = section.getAttribute("id");
    });

    navLinks.forEach(link => {
        link.classList.remove("active");
        if (link.getAttribute("href").substring(1) === currentSection) link.classList.add("active");
    });
});

function linkify(text) { return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'); }

window.addEventListener("DOMContentLoaded", () => {
    const savedEmail = localStorage.getItem("tm_email");
    if (savedEmail) {
        account = { address: savedEmail };
        const emailDisplay = document.getElementById("emailDisplay");
        if (emailDisplay) emailDisplay.innerText = savedEmail;
        checkInbox();
        inboxInterval = setInterval(checkInbox, 15000);
    }
});
