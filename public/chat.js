document.addEventListener("DOMContentLoaded", () => {
  // --- DOM Elements ---
  const sendButton = document.getElementById("send-btn");
  const chatBox = document.getElementById("chat-box");
  const userInputElement = document.getElementById("user-input");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebar = document.getElementById("sidebar");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");
  const sidebarClose = document.getElementById("sidebar-close");
  const newChatBtn = document.getElementById("new-chat-btn");
  const mobileNewChatBtn = document.getElementById("mobile-new-chat-btn");
  const conversationsList = document.getElementById("conversations-list");
  const loadingIndicator = document.getElementById("loading-indicator");

  // --- State Management ---
  let activeConversationId = null;
  let conversations = JSON.parse(localStorage.getItem('conversations') || '[]');

  // --- Initialization ---
  initializeUI();

  // --- UI Initialization ---
  function initializeUI() {
    if (!sendButton || !chatBox || !userInputElement) {
      console.error("Error: Missing UI elements in index.html! Check IDs.");
      return;
    }

    // Hide loading indicator on page load
    if (loadingIndicator) loadingIndicator.className = "loading-indicator-hidden";

    // Event Listeners
    sendButton.addEventListener("click", handleSendMessage);
    document.getElementById("chat-form").addEventListener("submit", (event) => {
      event.preventDefault();
      handleSendMessage();
    });

    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", toggleSidebar);
    }
    if (sidebarClose) {
      sidebarClose.addEventListener("click", closeSidebar);
    }
    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener("click", closeSidebar);
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && sidebar?.classList.contains("open")) {
        closeSidebar();
      }
    });

    window.addEventListener("resize", () => {
      if (!isMobileView()) {
        closeSidebar();
      }
    });

    if (newChatBtn) {
      newChatBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        createNewConversation();
      });
    }

    if (mobileNewChatBtn) {
      mobileNewChatBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        createNewConversation();
      });
    }

    setupMobileKeyboardDetection();
    loadConversations();

    if (conversations.length === 0) {
      createNewConversation();
    } else {
      loadConversation(conversations[0].id);
    }

    console.log("🤖 Chatbot initialized");
  }

  // --- Event Handlers ---

  function handleSendMessage() {
    const userMessage = userInputElement.value.trim();
    if (!userMessage || !activeConversationId) return;

    const sanitizedMessage = sanitizeInput(userMessage);
    if (!isValidMessage(sanitizedMessage)) return;

    appendMessage("user", sanitizedMessage);
    setConversationTitleFromFirstMessage(sanitizedMessage);
    addMessageToMemory("user", sanitizedMessage);
    userInputElement.value = "";

    showTypingIndicator(true);
    toggleInputDisabled(true);

    callApi(sanitizedMessage);
  }

  // --- API Call ---

  async function callApi(userMessage) {
    const context = getConversationContext();

    try {
      const response = await fetchWithRetry("/.netlify/functions/askai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, context: context }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`HTTP error! Status: ${response.status}, Message: ${errorData.error || 'Unknown error'}`);
      }

      const data = await response.json();
      const botReply = data.reply || data.error || "Sorry, I didn't get that.";

      appendMessage("bot", botReply);
      addMessageToMemory("bot", botReply);

    } catch (error) {
      console.error("Full error details:", error);
      const errorMessage = getErrorMessage(error);
      appendMessage("bot", errorMessage);
      addMessageToMemory("bot", errorMessage);
    } finally {
      showTypingIndicator(false);
      toggleInputDisabled(false);
      setTimeout(() => userInputElement.focus(), 50);
    }
  }

  async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
      console.log(`Attempt ${i + 1}: Calling API...`);
      const response = await fetch(url, options);
      console.log(`Response status: ${response.status}`);

      if (response.status === 429) {
        const delay = 2000 * (2 ** i);
        console.log(`Rate limited, retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        return response;
      }
    }
    throw new Error("Max retries reached");
  }

  // --- Message Handling ---

  function isValidMessage(message) {
    if (!message) {
      console.error('Message sanitized to empty string');
      return false;
    }

    if (message.length > 1000) {
      appendMessage("bot", "Message too long. Please keep your message under 1000 characters.");
      return false;
    }

    const suspiciousPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi, /data:/gi, /vbscript:/gi, /on\w+\s*=/gi,
      /<iframe/gi, /<object/gi, /<embed/gi
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(message)) {
        console.error('Suspicious input detected:', message);
        appendMessage("bot", "Invalid input detected. Please try again with a different message.");
        return false;
      }
    }

    return true;
  }

  function getErrorMessage(error) {
    if (error.message.includes("API configuration error")) {
      return "API configuration error. Please check the server setup.";
    } else if (error.message.includes("OpenRouter API error") || error.message.includes("LLM provider error") || error.message.includes("LLM HTTP error")) {
      return "AI provider error. Please check your Groq API key (GROQ_API_KEY).";
    } else if (error.message.includes("429") || error.message.includes("Max retries reached")) {
      return "Too many requests. Please wait a moment and try again.";
    }
    return "Error reaching AI service. Please try again later.";
  }

  function appendMessage(role, text) {
    const cleanText = sanitizeInput(text).trim();
    if (!cleanText) return;

    const wrapper = document.createElement("div");
    wrapper.className = `message-wrapper ${role}`;

    const msgDiv = document.createElement("div");
    msgDiv.className = `message ${role}-message`;
    msgDiv.innerText = cleanText;

    wrapper.appendChild(msgDiv);
    chatBox.appendChild(wrapper);

    // Animate message appearance
    setTimeout(() => {
      wrapper.style.transition = 'all 0.3s ease';
      wrapper.style.opacity = '1';
      wrapper.style.transform = 'translateY(0)';
    }, 10);

    scrollChatToBottom();
  }

  // --- Conversation Management ---

  function createNewConversation() {
    const conversationId = Date.now().toString();
    const conversation = {
      id: conversationId,
      title: "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    conversations.unshift(conversation);
    saveConversations();
    activeConversationId = conversationId;
    clearChatBox();
    renderConversationsList();
    focusChatInput();

    if (isMobileView()) {
      closeSidebar();
    }
  }

  function focusChatInput() {
    setTimeout(() => userInputElement?.focus(), isMobileView() ? 150 : 50);
  }

  function loadConversation(conversationId) {
    const conversation = conversations.find(c => c.id === conversationId);
    if (!conversation) {
      console.error('Conversation not found:', conversationId);
      return;
    }

    activeConversationId = conversationId;
    if (!conversation.messages || conversation.messages.length === 0) {
      clearChatBox();
    } else {
      renderMessages(conversation.messages);
    }
    renderConversationsList();
    if (isMobileView()) {
      closeSidebar();
    }
  }

  function addMessageToMemory(role, content) {
    if (!activeConversationId) return;
    const conversation = conversations.find(c => c.id === activeConversationId);
    if (!conversation) return;

    const lastMessage = conversation.messages[conversation.messages.length - 1];
    if (lastMessage && lastMessage.role === role && lastMessage.text === content) {
      return; // Prevent duplicate messages
    }

    conversation.messages.push({ role, text: content, timestamp: new Date().toISOString() });
    conversation.updatedAt = new Date().toISOString();
    saveConversations();
    renderConversationsList();
  }

  function getConversationContext() {
    if (!activeConversationId) return [];
    const conversation = conversations.find(c => c.id === activeConversationId);
    if (!conversation) return [];

    return conversation.messages.slice(-10).map(msg => ({ role: msg.role, content: msg.text }));
  }

  function getConversationTitleFromMessage(message) {
    const cleaned = sanitizeInput(message).replace(/\s+/g, " ").trim();
    if (!cleaned) return "New Chat";
    return cleaned.length > 40 ? `${cleaned.substring(0, 40)}...` : cleaned;
  }

  function setConversationTitleFromFirstMessage(userMessage) {
    const conversation = conversations.find((c) => c.id === activeConversationId);
    if (!conversation || conversation.title !== "New Chat") return;

    const userMessageCount = conversation.messages.filter((msg) => msg.role === "user").length;
    if (userMessageCount === 0) {
      updateConversationTitle(activeConversationId, getConversationTitleFromMessage(userMessage));
    }
  }

  function updateConversationTitle(conversationId, title) {
    const conversation = conversations.find(c => c.id === conversationId);
    if (conversation) {
      conversation.title = title;
      saveConversations();
      renderConversationsList();
    }
  }

  // --- UI Helper Functions ---

  function isMobileView() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function toggleSidebar() {
    if (!sidebar || !sidebarBackdrop) return;

    if (document.activeElement === userInputElement) {
      userInputElement.blur();
    }

    const isOpen = sidebar.classList.toggle("open");
    sidebarBackdrop.classList.toggle("open", isOpen);
    document.body.style.overflow = isOpen ? "hidden" : "";

    if (sidebarToggle) {
      sidebarToggle.setAttribute("aria-expanded", String(isOpen));
      sidebarToggle.setAttribute("aria-label", isOpen ? "Close conversations" : "Open conversations");
    }
  }

  function closeSidebar() {
    if (!sidebar || !sidebarBackdrop) return;

    sidebar.classList.remove("open");
    sidebarBackdrop.classList.remove("open");
    document.body.style.overflow = "";

    if (sidebarToggle) {
      sidebarToggle.setAttribute("aria-expanded", "false");
      sidebarToggle.setAttribute("aria-label", "Open conversations");
    }
  }

  function renderMessages(messages) {
    chatBox.innerHTML = '';
    if (!Array.isArray(messages)) return;

    const uniqueMessages = messages.filter((message, index, array) => {
      const prev = array[index - 1];
      return !prev || !(message.role === prev.role && message.text === prev.text);
    });

    uniqueMessages.forEach((message, index) => {
      appendMessage(message.role, message.text);
    });

    setTimeout(scrollChatToBottom, uniqueMessages.length * 50 + 100);
  }

  function renderConversationsList() {
    if (!conversationsList) return;

    conversationsList.innerHTML = '';
    conversations.forEach(conversation => {
      const el = document.createElement('div');
      el.className = `conversation-item ${conversation.id === activeConversationId ? 'active' : ''}`;
      el.setAttribute('data-conversation-id', conversation.id);

      const info = document.createElement('div');
      info.className = 'conversation-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'conversation-title';
      titleEl.textContent = conversation.title || 'New Chat';

      const dateEl = document.createElement('div');
      dateEl.className = 'conversation-date';
      dateEl.textContent = formatDate(conversation.updatedAt);

      info.appendChild(titleEl);
      info.appendChild(dateEl);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-conversation';
      deleteBtn.type = 'button';
      deleteBtn.setAttribute('aria-label', `Delete ${conversation.title || 'chat'}`);
      deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';

      el.appendChild(info);
      el.appendChild(deleteBtn);

      el.addEventListener('click', (e) => {
        if (!e.target.closest('.delete-conversation')) {
          loadConversation(conversation.id);
        }
      });

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(conversation.id);
      });

      conversationsList.appendChild(el);
    });
  }

  function clearChatBox() {
    chatBox.innerHTML = '';
  }

  function showTypingIndicator(show) {
    if (loadingIndicator) {
      loadingIndicator.className = show ? "loading-indicator-visible" : "loading-indicator-hidden";
    }
  }

  function toggleInputDisabled(disabled) {
    userInputElement.disabled = disabled;
    sendButton.disabled = disabled;
  }

  function scrollChatToBottom() {
    requestAnimationFrame(() => {
      if (chatBox) {
        chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "smooth" });
      }
    });
  }

  // --- Utility Functions ---

  function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/<[^>]*>/g, "").trim(); // Simple tag removal
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now - date) / (1000 * 60 * 60);

    if (diffInHours < 1) return "Just now";
    if (diffInHours < 24) return `${Math.floor(diffInHours)}h ago`;
    return date.toLocaleDateString();
  }

  function saveConversations() {
    localStorage.setItem('conversations', JSON.stringify(conversations));
  }

  function loadConversations() {
    conversations = JSON.parse(localStorage.getItem('conversations') || '[]');
    conversations.forEach(convo => {
      if (convo.title === "New Chat" && convo.messages?.length > 0) {
        const firstUserMsg = convo.messages.find(msg => msg.role === "user");
        if (firstUserMsg) {
          convo.title = getConversationTitleFromMessage(firstUserMsg.text);
        }
      }
    });
    saveConversations();
    renderConversationsList();
  }

  function deleteConversation(conversationId) {
    conversations = conversations.filter(c => c.id !== conversationId);
    saveConversations();

    if (activeConversationId === conversationId) {
      if (conversations.length > 0) {
        loadConversation(conversations[0].id);
      } else {
        createNewConversation();
      }
    }
    renderConversationsList();
  }

  // --- Mobile Specific ---

  function setupMobileKeyboardDetection() {
    userInputElement.addEventListener("focus", () => {
      if (sidebar?.classList.contains("open")) closeSidebar();
      setTimeout(scrollChatToBottom, 50);
    });

    userInputElement.addEventListener("input", () => {
      setTimeout(scrollChatToBottom, 10);
    });

    document.getElementById("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      handleSendMessage();
    });

    userInputElement.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  }
});