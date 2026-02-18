const activityLog = document.getElementById("activity-log");
const currentUserElement = document.getElementById("current-user");

const state = {
  userId: localStorage.getItem("userId") || "",
  token: localStorage.getItem("token") || "",
};

function setCurrentUserLabel() {
  currentUserElement.textContent = state.userId || "Not logged in";
}

setCurrentUserLabel();

function log(message, payload) {
  const ts = new Date().toISOString();
  const line = payload ? `${ts} ${message}\n${JSON.stringify(payload, null, 2)}` : `${ts} ${message}`;
  activityLog.textContent = `${line}\n\n${activityLog.textContent}`;
}

function requireLogin(actionName) {
  if (!state.userId || !state.token) {
    log(`${actionName} blocked`, { error: "Log in first." });
    return false;
  }
  return true;
}

function csvToArray(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  let payload;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    payload = await response.text();
  }

  if (!response.ok) {
    throw new Error(typeof payload === "string" ? payload : payload.error || "Request failed");
  }

  return payload;
}

document.getElementById("signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("signup-name").value,
        email: document.getElementById("signup-email").value,
        password: document.getElementById("signup-password").value,
      }),
    });
    state.userId = payload.user.id;
    localStorage.setItem("userId", state.userId);
    setCurrentUserLabel();
    log("Signup successful", payload);
  } catch (error) {
    log("Signup failed", { error: error.message });
  }
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("login-email").value,
        password: document.getElementById("login-password").value,
      }),
    });

    state.userId = payload.user.id;
    state.token = payload.token;
    localStorage.setItem("userId", state.userId);
    localStorage.setItem("token", state.token);
    setCurrentUserLabel();
    log("Login successful", payload);
  } catch (error) {
    log("Login failed", { error: error.message });
  }
});

document.getElementById("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Profile update")) {
    return;
  }

  try {
    const payload = await api(`/api/profiles/${state.userId}`, {
      method: "PUT",
      body: JSON.stringify({
        about: document.getElementById("profile-about").value,
        skills: csvToArray(document.getElementById("profile-skills").value),
        classes: csvToArray(document.getElementById("profile-classes").value),
        availability: document.getElementById("profile-availability").value,
        profilePictureUrl: document.getElementById("profile-picture-url").value,
      }),
    });
    log("Profile saved", payload);
  } catch (error) {
    log("Profile save failed", { error: error.message });
  }
});

document.getElementById("profile-picture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Profile picture upload")) {
    return;
  }

  const fileInput = document.getElementById("profile-picture-file");
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    log("Profile picture upload blocked", { error: "Choose an image file first." });
    return;
  }

  try {
    const uploadMeta = await api(`/api/profiles/${state.userId}/picture/upload-url`, {
      method: "POST",
      body: JSON.stringify({ contentType: file.type || "image/jpeg" }),
    });

    const uploadResponse = await fetch(uploadMeta.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": uploadMeta.contentType,
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Object storage upload failed (${uploadResponse.status})`);
    }

    const confirmPayload = await api(`/api/profiles/${state.userId}/picture/confirm`, {
      method: "POST",
      body: JSON.stringify({ objectKey: uploadMeta.objectKey }),
    });

    document.getElementById("profile-picture-url").value = confirmPayload.profilePictureUrl;
    log("Profile picture uploaded", confirmPayload);
  } catch (error) {
    log("Profile picture upload failed", { error: error.message });
  }
});

document.getElementById("search-classes").addEventListener("click", async () => {
  try {
    const q = encodeURIComponent(document.getElementById("class-query").value || "");
    const payload = await api(`/api/classes?q=${q}`);
    document.getElementById("class-results").textContent = JSON.stringify(payload, null, 2);
    log("Class search completed", { count: payload.classes.length });
  } catch (error) {
    log("Class search failed", { error: error.message });
  }
});

document.getElementById("enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Enrollment")) {
    return;
  }

  try {
    const payload = await api("/api/classes/enrollments", {
      method: "POST",
      body: JSON.stringify({
        classId: document.getElementById("enroll-class-id").value,
      }),
    });
    log("Enrolled in class", payload);
  } catch (error) {
    log("Enrollment failed", { error: error.message });
  }
});

document.getElementById("load-members").addEventListener("click", async () => {
  try {
    const classId = document.getElementById("members-class-id").value;
    const payload = await api(`/api/classes/${encodeURIComponent(classId)}/members`);
    document.getElementById("member-results").textContent = JSON.stringify(payload, null, 2);
    log("Loaded class roster", payload);
  } catch (error) {
    log("Load members failed", { error: error.message });
  }
});

document.getElementById("create-group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Create group")) {
    return;
  }

  try {
    const classId = document.getElementById("group-class-id").value;
    const payload = await api(`/api/classes/${encodeURIComponent(classId)}/groups`, {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("group-name").value,
        projectSection: document.getElementById("group-section").value,
      }),
    });
    log("Group created", payload);
  } catch (error) {
    log("Create group failed", { error: error.message });
  }
});

document.getElementById("request-group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Join request")) {
    return;
  }

  try {
    const groupId = document.getElementById("request-group-id").value;
    const payload = await api(`/api/classes/groups/${encodeURIComponent(groupId)}/requests`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    log("Join request submitted", payload);
  } catch (error) {
    log("Join request failed", { error: error.message });
  }
});

document.getElementById("load-group-requests").addEventListener("click", async () => {
  if (!requireLogin("Load group requests")) {
    return;
  }

  try {
    const groupId = document.getElementById("group-requests-group-id").value;
    const payload = await api(`/api/classes/groups/${encodeURIComponent(groupId)}/requests?status=ALL`);
    document.getElementById("group-request-results").textContent = JSON.stringify(payload, null, 2);
    log("Loaded group requests", { groupId, count: payload.requests.length });
  } catch (error) {
    log("Load group requests failed", { error: error.message });
  }
});

document.getElementById("approve-group-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Approve request")) {
    return;
  }

  try {
    const groupId = document.getElementById("approve-group-id").value;
    const userId = document.getElementById("approve-user-id").value;
    const payload = await api(
      `/api/classes/groups/${encodeURIComponent(groupId)}/requests/${encodeURIComponent(userId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    log("Join request approved", payload);
  } catch (error) {
    log("Approve request failed", { error: error.message });
  }
});

document.getElementById("reject-group-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Reject request")) {
    return;
  }

  try {
    const groupId = document.getElementById("reject-group-id").value;
    const userId = document.getElementById("reject-user-id").value;
    const payload = await api(
      `/api/classes/groups/${encodeURIComponent(groupId)}/requests/${encodeURIComponent(userId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    log("Join request rejected", payload);
  } catch (error) {
    log("Reject request failed", { error: error.message });
  }
});

document.getElementById("conversation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Conversation create")) {
    return;
  }

  try {
    const members = csvToArray(document.getElementById("conversation-members").value);
    const payload = await api("/api/messages/conversations", {
      method: "POST",
      body: JSON.stringify({
        type: document.getElementById("conversation-type").value,
        memberUserIds: members,
        classId: document.getElementById("conversation-class-id").value || null,
        groupId: document.getElementById("conversation-group-id").value || null,
      }),
    });
    log("Conversation created", payload);
  } catch (error) {
    log("Conversation creation failed", { error: error.message });
  }
});

document.getElementById("send-message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireLogin("Message send")) {
    return;
  }

  try {
    const conversationId = document.getElementById("message-conversation-id").value;
    const payload = await api(`/api/messages/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: document.getElementById("message-body").value,
      }),
    });
    log("Message sent", payload);
  } catch (error) {
    log("Message send failed", { error: error.message });
  }
});

document.getElementById("load-messages").addEventListener("click", async () => {
  if (!requireLogin("Load messages")) {
    return;
  }

  try {
    const conversationId = document.getElementById("messages-conversation-id").value;
    const payload = await api(`/api/messages/conversations/${encodeURIComponent(conversationId)}/messages`);
    document.getElementById("message-results").textContent = JSON.stringify(payload, null, 2);
    log("Loaded messages", { count: payload.messages.length });
  } catch (error) {
    log("Load messages failed", { error: error.message });
  }
});

document.getElementById("load-recommendations").addEventListener("click", async () => {
  if (!requireLogin("Load recommendations")) {
    return;
  }

  try {
    const payload = await api(`/api/recommendations/${state.userId}`);
    document.getElementById("recommendation-results").textContent = JSON.stringify(payload, null, 2);
    log("Recommendations loaded", payload);
  } catch (error) {
    log("Load recommendations failed", { error: error.message });
  }
});
