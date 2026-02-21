import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

function formatConversationLabel(conversation) {
  if (conversation.type === "DM") {
    return `DM (${conversation.members.join(", ")})`;
  }
  if (conversation.type === "GROUP") {
    return `Group ${conversation.groupId || conversation.id}`;
  }
  if (conversation.type === "CLASS") {
    return `Class ${conversation.classId || conversation.id}`;
  }
  return conversation.id;
}

function uniqueMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    out.push(message);
  }
  return out;
}

export default function ChatsPage() {
  const { apiFetch, getValidAccessToken, session } = useAuth();
  const location = useLocation();

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [messages, setMessages] = useState([]);
  const [presenceUsers, setPresenceUsers] = useState([]);
  const [typingUsersByConversation, setTypingUsersByConversation] = useState({});
  const [draftMessage, setDraftMessage] = useState("");
  const [newConversationOtherUserId, setNewConversationOtherUserId] = useState("");
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const socketRef = useRef(null);
  const joinedConversationRef = useRef("");
  const typingTimeoutRef = useRef(null);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  const preselectedConversationId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("conversation") || "";
  }, [location.search]);

  const typingUsers = useMemo(() => {
    return typingUsersByConversation[selectedConversationId] || [];
  }, [typingUsersByConversation, selectedConversationId]);

  const otherTypingUsers = useMemo(() => {
    return typingUsers.filter((userId) => userId !== session.user?.id);
  }, [typingUsers, session.user?.id]);

  const loadConversations = useCallback(async () => {
    setIsLoadingConversations(true);
    setError("");
    try {
      const payload = await apiFetch("/api/messages/conversations?limit=100");
      const nextConversations = payload.conversations || [];
      setConversations(nextConversations);

      setSelectedConversationId((currentValue) => {
        if (preselectedConversationId && nextConversations.some((item) => item.id === preselectedConversationId)) {
          return preselectedConversationId;
        }
        if (currentValue && nextConversations.some((item) => item.id === currentValue)) {
          return currentValue;
        }
        return nextConversations.length > 0 ? nextConversations[0].id : "";
      });
    } catch (fetchError) {
      setError(fetchError.message || "Failed to load conversations");
    } finally {
      setIsLoadingConversations(false);
    }
  }, [apiFetch, preselectedConversationId]);

  const loadMessages = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        return;
      }

      setIsLoadingMessages(true);
      setError("");

      try {
        const payload = await apiFetch(
          `/api/messages/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
        );
        setMessages(payload.messages || []);
        await apiFetch(`/api/messages/conversations/${encodeURIComponent(conversationId)}/read`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      } catch (fetchError) {
        setError(fetchError.message || "Failed to load messages");
      } finally {
        setIsLoadingMessages(false);
      }
    },
    [apiFetch],
  );

  const loadPresence = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        setPresenceUsers([]);
        return;
      }

      try {
        const payload = await apiFetch(`/api/messages/conversations/${encodeURIComponent(conversationId)}/presence`);
        setPresenceUsers(payload.onlineUserIds || []);
      } catch (_error) {
        setPresenceUsers([]);
      }
    },
    [apiFetch],
  );

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      setPresenceUsers([]);
      return;
    }

    loadMessages(selectedConversationId);
    loadPresence(selectedConversationId);
  }, [selectedConversationId, loadMessages, loadPresence]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const bindSocketHandlers = useCallback(
    (socket) => {
      socket.on("connect", () => {
        setIsRealtimeConnected(true);
        setInfo("Realtime connected");
      });

      socket.on("disconnect", () => {
        setIsRealtimeConnected(false);
      });

      socket.on("connect_error", (socketError) => {
        setError(socketError.message || "Failed to connect realtime");
        setIsRealtimeConnected(false);
      });

      socket.on("message:new", ({ conversationId, message }) => {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  lastMessage: {
                    id: message.id,
                    body: message.body,
                    senderUserId: message.sender_user_id,
                    createdAt: message.created_at,
                  },
                }
              : conversation,
          ),
        );

        if (conversationId === selectedConversationId) {
          setMessages((prev) => uniqueMessages([...prev, message]));
        }
      });

      socket.on("presence:update", ({ conversationId, userId, isOnline }) => {
        if (conversationId !== selectedConversationId) {
          return;
        }

        setPresenceUsers((prev) => {
          if (isOnline) {
            return prev.includes(userId) ? prev : [...prev, userId];
          }
          return prev.filter((value) => value !== userId);
        });
      });

      socket.on("typing:update", ({ conversationId, userId, isTyping }) => {
        setTypingUsersByConversation((prev) => {
          const existing = new Set(prev[conversationId] || []);
          if (isTyping) {
            existing.add(userId);
          } else {
            existing.delete(userId);
          }
          return {
            ...prev,
            [conversationId]: Array.from(existing),
          };
        });
      });
    },
    [selectedConversationId],
  );

  const connectRealtime = useCallback(async () => {
    setError("");

    if (socketRef.current && socketRef.current.connected) {
      setInfo("Realtime already connected");
      return;
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      setError("Unable to get valid access token for realtime connection");
      return;
    }

    const socket = io(window.location.origin, {
      path: "/ws/socket.io",
      transports: ["websocket", "polling"],
      auth: {
        token: `Bearer ${accessToken}`,
      },
    });

    bindSocketHandlers(socket);
    socketRef.current = socket;
  }, [bindSocketHandlers, getValidAccessToken]);

  const disconnectRealtime = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setIsRealtimeConnected(false);
      setInfo("Realtime disconnected");
    }
  }, []);

  const emitWithAck = useCallback((eventName, payload) => {
    return new Promise((resolve) => {
      if (!socketRef.current || !socketRef.current.connected) {
        resolve({ ok: false, error: "Realtime socket is not connected" });
        return;
      }

      socketRef.current.emit(eventName, payload, (response) => {
        resolve(response || { ok: false, error: "No response" });
      });
    });
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      return;
    }

    const previousConversationId = joinedConversationRef.current;

    async function syncRealtimeRoom() {
      if (previousConversationId && previousConversationId !== selectedConversationId) {
        await emitWithAck("conversation:leave", { conversationId: previousConversationId });
      }

      if (selectedConversationId) {
        const response = await emitWithAck("conversation:join", { conversationId: selectedConversationId });
        if (response.ok && Array.isArray(response.onlineUserIds)) {
          setPresenceUsers(response.onlineUserIds);
        }
      }

      joinedConversationRef.current = selectedConversationId;
    }

    syncRealtimeRoom();
  }, [selectedConversationId, emitWithAck, isRealtimeConnected]);

  const handleCreateConversation = useCallback(
    async (event) => {
      event.preventDefault();
      setError("");
      setInfo("");

      const otherUserId = newConversationOtherUserId.trim();
      if (!otherUserId) {
        setError("Other user ID is required");
        return;
      }

      try {
        const payload = await apiFetch("/api/messages/conversations/dm", {
          method: "POST",
          body: JSON.stringify({
            otherUserId,
          }),
        });

        setInfo(payload.created ? `Conversation ${payload.conversation.id} created` : `Conversation ${payload.conversation.id} opened`);
        setNewConversationOtherUserId("");
        await loadConversations();
        setSelectedConversationId(payload.conversation.id);
      } catch (createError) {
        setError(createError.message || "Failed to create conversation");
      }
    },
    [apiFetch, newConversationOtherUserId, loadConversations],
  );

  const sendMessageHttp = useCallback(
    async (conversationId, body) => {
      const payload = await apiFetch(`/api/messages/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setMessages((prev) => uniqueMessages([...prev, payload.message]));
      return payload.message;
    },
    [apiFetch],
  );

  const handleSendMessage = useCallback(
    async (event) => {
      event.preventDefault();
      setError("");

      const conversationId = selectedConversationId;
      const body = draftMessage.trim();
      if (!conversationId || !body) {
        return;
      }

      try {
        if (isRealtimeConnected) {
          const response = await emitWithAck("message:send", { conversationId, body });
          if (!response.ok) {
            throw new Error(response.error || "Realtime send failed");
          }
          setMessages((prev) => uniqueMessages([...prev, response.message]));
        } else {
          await sendMessageHttp(conversationId, body);
        }

        setDraftMessage("");
        setTypingUsersByConversation((prev) => ({
          ...prev,
          [conversationId]: (prev[conversationId] || []).filter((userId) => userId !== session.user?.id),
        }));

        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = null;
        }

        if (isRealtimeConnected) {
          await emitWithAck("typing:stop", { conversationId });
        }
      } catch (sendError) {
        setError(sendError.message || "Failed to send message");
      }
    },
    [draftMessage, selectedConversationId, isRealtimeConnected, emitWithAck, sendMessageHttp, session.user?.id],
  );

  const handleDraftChange = useCallback(
    (event) => {
      const value = event.target.value;
      setDraftMessage(value);

      if (!isRealtimeConnected || !selectedConversationId) {
        return;
      }

      emitWithAck("typing:start", { conversationId: selectedConversationId });

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      typingTimeoutRef.current = setTimeout(() => {
        emitWithAck("typing:stop", { conversationId: selectedConversationId });
      }, 1200);
    },
    [isRealtimeConnected, selectedConversationId, emitWithAck],
  );

  return (
    <div className="page-grid chats-grid">
      <section className="card">
        <div className="section-heading">
          <h2>Conversations</h2>
          <button className="btn btn-ghost" type="button" onClick={loadConversations}>
            Refresh
          </button>
        </div>

        <div className="inline-actions">
          <button className="btn btn-primary" type="button" onClick={connectRealtime}>
            Connect Realtime
          </button>
          <button className="btn btn-secondary" type="button" onClick={disconnectRealtime}>
            Disconnect
          </button>
          <span className={isRealtimeConnected ? "status-dot online" : "status-dot"}>
            {isRealtimeConnected ? "Realtime connected" : "Realtime offline"}
          </span>
        </div>

        {isLoadingConversations ? <p className="muted">Loading conversations...</p> : null}

        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={conversation.id === selectedConversationId ? "conversation-item active" : "conversation-item"}
              onClick={() => setSelectedConversationId(conversation.id)}
            >
              <div className="conversation-title-row">
                <strong>{formatConversationLabel(conversation)}</strong>
                {conversation.unreadCount > 0 ? <span className="badge solid">{conversation.unreadCount}</span> : null}
              </div>
              <small>{conversation.lastMessage?.body || "No messages yet"}</small>
            </button>
          ))}
        </div>

        <form className="form-grid" onSubmit={handleCreateConversation}>
          <h3>Start Direct Message</h3>
          <label>
            Other user ID
            <input
              value={newConversationOtherUserId}
              onChange={(event) => setNewConversationOtherUserId(event.target.value)}
              placeholder="auth0|..."
              required
            />
          </label>
          <button className="btn btn-primary" type="submit">
            Open DM
          </button>
        </form>
      </section>

      <section className="card chat-thread-card">
        <div className="section-heading">
          <h2>Messages</h2>
          <span className="muted">{selectedConversation ? formatConversationLabel(selectedConversation) : "Select a chat"}</span>
        </div>

        {selectedConversationId ? null : <p className="muted">Select a conversation to read and send messages.</p>}

        {selectedConversationId ? (
          <>
            <div className="presence-row">
              <strong>Online in this chat:</strong>
              <span>{presenceUsers.length > 0 ? presenceUsers.join(", ") : "No one currently online"}</span>
            </div>

            {otherTypingUsers.length > 0 ? (
              <p className="typing-indicator">Typing: {otherTypingUsers.join(", ")}</p>
            ) : null}

            <div className="message-list" role="log" aria-live="polite">
              {isLoadingMessages ? <p className="muted">Loading messages...</p> : null}
              {messages.map((message) => {
                const mine = message.sender_user_id === session.user?.id || message.senderUserId === session.user?.id;
                const sender = message.sender_user_id || message.senderUserId;
                const created = message.created_at || message.createdAt;
                return (
                  <article className={mine ? "message-bubble mine" : "message-bubble"} key={message.id}>
                    <header>
                      <strong>{mine ? "You" : sender}</strong>
                      <small>{created ? new Date(created).toLocaleTimeString() : ""}</small>
                    </header>
                    <p>{message.body}</p>
                  </article>
                );
              })}
            </div>

            <form className="message-input-row" onSubmit={handleSendMessage}>
              <input
                value={draftMessage}
                onChange={handleDraftChange}
                placeholder="Write a message"
                aria-label="Message"
              />
              <button className="btn btn-primary" type="submit">
                Send
              </button>
            </form>
          </>
        ) : null}

        {info ? <p className="notice success">{info}</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </section>
    </div>
  );
}
