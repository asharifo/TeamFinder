import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io } from "socket.io-client";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

function loadHiddenConversationIds(storageKey) {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((value) => String(value)).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function saveHiddenConversationIds(storageKey, conversationIds) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const uniqueIds = Array.from(
      new Set(
        (conversationIds || []).map((value) => String(value)).filter(Boolean)
      )
    );
    window.localStorage.setItem(storageKey, JSON.stringify(uniqueIds));
  } catch (_error) {
    // Ignore localStorage persistence errors.
  }
}

function formatConversationLabel(conversation, currentUserId, resolveUserName) {
  if (conversation.type === "DM") {
    const memberIds = Array.isArray(conversation.members) ? conversation.members : [];
    const otherMemberIds = memberIds.filter((userId) => userId !== currentUserId);
    const labelIds = otherMemberIds.length > 0 ? otherMemberIds : memberIds;
    const names = labelIds.map((userId) => resolveUserName(userId)).filter(Boolean);
    return names.length > 0 ? names.join(", ") : "Direct Message";
  }
  if (conversation.type === "GROUP") {
    const groupName = String(conversation.groupName || conversation.group_name || "").trim();
    const classCode = String(conversation.classId || conversation.class_id || "").trim();
    if (groupName && classCode) {
      return `${groupName} (${classCode})`;
    }
    if (groupName) {
      return groupName;
    }
    if (classCode) {
      return `Group Chat (${classCode})`;
    }
    return "Group Chat";
  }
  if (conversation.type === "CLASS") {
    const className = String(conversation.className || conversation.class_name || "").trim();
    return className ? `Class ${className}` : "Class Chat";
  }
  return "Conversation";
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
  const [typingUsersByConversation, setTypingUsersByConversation] = useState(
    {}
  );
  const [userDirectoryById, setUserDirectoryById] = useState({});
  const [draftMessage, setDraftMessage] = useState("");
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hiddenConversationIds, setHiddenConversationIds] = useState([]);
  const [error, setError] = useState("");

  const socketRef = useRef(null);
  const joinedConversationRef = useRef("");
  const typingTimeoutRef = useRef(null);
  const selectedConversationIdRef = useRef("");
  const userDirectoryRef = useRef(userDirectoryById);

  const preselectedConversationId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("conversation") || "";
  }, [location.search]);

  useEffect(() => {
    userDirectoryRef.current = userDirectoryById;
  }, [userDirectoryById]);

  const hiddenConversationsStorageKey = useMemo(
    () => `teamfinder:hidden-conversations:${session.user?.id || "anonymous"}`,
    [session.user?.id]
  );

  const ensureUserDirectoryEntries = useCallback(
    async (rawUserIds) => {
      const requestedIds = Array.from(
        new Set(
          (rawUserIds || [])
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        )
      );
      if (requestedIds.length === 0) {
        return;
      }

      const missingUserIds = requestedIds.filter(
        (userId) =>
          userId !== session.user?.id && !userDirectoryRef.current[userId]
      );
      if (missingUserIds.length === 0) {
        return;
      }

      try {
        const payload = await apiFetch("/api/classes/users/lookup", {
          method: "POST",
          body: JSON.stringify({ userIds: missingUserIds }),
        });

        const users = Array.isArray(payload.users) ? payload.users : [];
        if (users.length === 0) {
          return;
        }

        setUserDirectoryById((prev) => {
          const next = { ...prev };
          for (const user of users) {
            const userId = String(user.user_id || "").trim();
            if (!userId) {
              continue;
            }
            next[userId] = {
              userName: typeof user.user_name === "string" ? user.user_name : "",
              userEmail: typeof user.user_email === "string" ? user.user_email : "",
              profilePictureUrl:
                typeof user.profile_picture_url === "string"
                  ? user.profile_picture_url
                  : "",
              about: typeof user.about === "string" ? user.about : "",
              skills: Array.isArray(user.skills) ? user.skills : [],
            };
          }
          return next;
        });
      } catch (_error) {
        // Best-effort enrichment only.
      }
    },
    [apiFetch, session.user?.id]
  );

  const resolveUserName = useCallback(
    (userId) => {
      const normalizedUserId = String(userId || "").trim();
      if (!normalizedUserId) {
        return "Unknown User";
      }
      if (normalizedUserId === session.user?.id) {
        return session.user?.name || "You";
      }
      return (
        userDirectoryById[normalizedUserId]?.userName ||
        "Unknown User"
      );
    },
    [session.user?.id, session.user?.name, userDirectoryById]
  );

  const ensureGroupConversationLabels = useCallback(
    async (conversationsToCheck) => {
      const targets = (conversationsToCheck || []).filter(
        (conversation) =>
          conversation.type === "GROUP" &&
          conversation.groupId &&
          (!conversation.groupName || !conversation.classId)
      );
      if (targets.length === 0) {
        return;
      }

      const updates = await Promise.all(
        targets.map(async (conversation) => {
          try {
            const groupPayload = await apiFetch(
              `/api/classes/groups/${encodeURIComponent(conversation.groupId)}`
            );
            const group = groupPayload.group || {};
            const groupName = String(group.name || "").trim();
            const classCode = String(group.classId || group.class_id || "").trim();

            return {
              id: conversation.id,
              groupName,
              classCode,
            };
          } catch (_error) {
            return null;
          }
        })
      );

      const updatesById = new Map(
        updates
          .filter(
            (item) => item && (item.groupName || item.classCode)
          )
          .map((item) => [item.id, item])
      );
      if (updatesById.size === 0) {
        return;
      }

      setConversations((prev) =>
        prev.map((conversation) => {
          const update = updatesById.get(conversation.id);
          if (!update) {
            return conversation;
          }
          return {
            ...conversation,
            groupName: update.groupName || conversation.groupName || "",
            classId: update.classCode || conversation.classId || "",
            className: update.classCode || conversation.className || "",
          };
        })
      );
    },
    [apiFetch]
  );

  useEffect(() => {
    setHiddenConversationIds(
      loadHiddenConversationIds(hiddenConversationsStorageKey)
    );
  }, [hiddenConversationsStorageKey]);

  useEffect(() => {
    saveHiddenConversationIds(
      hiddenConversationsStorageKey,
      hiddenConversationIds
    );
  }, [hiddenConversationsStorageKey, hiddenConversationIds]);

  const hiddenConversationSet = useMemo(
    () => new Set(hiddenConversationIds),
    [hiddenConversationIds]
  );

  const visibleConversations = useMemo(
    () =>
      conversations.filter(
        (conversation) => !hiddenConversationSet.has(conversation.id)
      ),
    [conversations, hiddenConversationSet]
  );

  const selectedConversation = useMemo(
    () =>
      visibleConversations.find(
        (conversation) => conversation.id === selectedConversationId
      ) || null,
    [visibleConversations, selectedConversationId]
  );

  const typingUsers = useMemo(() => {
    return typingUsersByConversation[selectedConversationId] || [];
  }, [typingUsersByConversation, selectedConversationId]);

  const otherTypingUserNames = useMemo(() => {
    return typingUsers
      .filter((userId) => userId !== session.user?.id)
      .map((userId) => resolveUserName(userId));
  }, [typingUsers, session.user?.id, resolveUserName]);

  const presenceUserNames = useMemo(() => {
    return presenceUsers.map((userId) => {
      if (userId === session.user?.id) {
        return "You";
      }
      return resolveUserName(userId);
    });
  }, [presenceUsers, resolveUserName, session.user?.id]);

  const loadConversations = useCallback(async () => {
    setIsLoadingConversations(true);
    setError("");
    try {
      const payload = await apiFetch("/api/messages/conversations?limit=100");
      const nextConversations = payload.conversations || [];
      setConversations(nextConversations);
      await ensureUserDirectoryEntries(
        nextConversations.flatMap((conversation) => {
          const members = Array.isArray(conversation.members)
            ? conversation.members
            : [];
          const senderId =
            conversation.lastMessage?.senderUserId ||
            conversation.lastMessage?.sender_user_id ||
            "";
          return [...members, senderId];
        })
      );
      await ensureGroupConversationLabels(nextConversations);
      if (
        preselectedConversationId &&
        nextConversations.some((item) => item.id === preselectedConversationId)
      ) {
        setHiddenConversationIds((currentValue) =>
          currentValue.filter(
            (conversationId) => conversationId !== preselectedConversationId
          )
        );
      }
    } catch (fetchError) {
      setError(fetchError.message || "Failed to load conversations");
    } finally {
      setIsLoadingConversations(false);
    }
  }, [
    apiFetch,
    ensureGroupConversationLabels,
    ensureUserDirectoryEntries,
    preselectedConversationId,
  ]);

  const loadMessages = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        return;
      }

      setIsLoadingMessages(true);
      setError("");

      try {
        const payload = await apiFetch(
          `/api/messages/conversations/${encodeURIComponent(
            conversationId
          )}/messages?limit=200`
        );
        const nextMessages = payload.messages || [];
        setMessages(nextMessages);
        await ensureUserDirectoryEntries(
          nextMessages.map(
            (message) => message.sender_user_id || message.senderUserId || ""
          )
        );
        await apiFetch(
          `/api/messages/conversations/${encodeURIComponent(
            conversationId
          )}/read`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );
      } catch (fetchError) {
        setError(fetchError.message || "Failed to load messages");
      } finally {
        setIsLoadingMessages(false);
      }
    },
    [apiFetch, ensureUserDirectoryEntries]
  );

  const loadPresence = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        setPresenceUsers([]);
        return;
      }

      try {
        const payload = await apiFetch(
          `/api/messages/conversations/${encodeURIComponent(
            conversationId
          )}/presence`
        );
        const nextOnlineUserIds = payload.onlineUserIds || [];
        setPresenceUsers(nextOnlineUserIds);
        await ensureUserDirectoryEntries(nextOnlineUserIds);
      } catch (_error) {
        setPresenceUsers([]);
      }
    },
    [apiFetch, ensureUserDirectoryEntries]
  );

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    setSelectedConversationId((currentValue) => {
      if (
        preselectedConversationId &&
        visibleConversations.some(
          (item) => item.id === preselectedConversationId
        )
      ) {
        return preselectedConversationId;
      }
      if (
        currentValue &&
        visibleConversations.some((item) => item.id === currentValue)
      ) {
        return currentValue;
      }
      return visibleConversations.length > 0 ? visibleConversations[0].id : "";
    });
  }, [preselectedConversationId, visibleConversations]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

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

  const bindSocketHandlers = useCallback((socket) => {
    socket.on("connect", () => {
      setIsRealtimeConnected(true);
    });

    socket.on("disconnect", () => {
      setIsRealtimeConnected(false);
    });

    socket.on("connect_error", (socketError) => {
      setError(socketError.message || "Failed to connect realtime");
      setIsRealtimeConnected(false);
    });

    socket.on("message:new", ({ conversationId, message }) => {
      const senderId = message?.sender_user_id || message?.senderUserId || "";
      ensureUserDirectoryEntries([senderId]);

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
            : conversation
        )
      );

      if (conversationId === selectedConversationIdRef.current) {
        setMessages((prev) => uniqueMessages([...prev, message]));
      }
    });

    socket.on("presence:update", ({ conversationId, userId, isOnline }) => {
      ensureUserDirectoryEntries([userId]);
      if (conversationId !== selectedConversationIdRef.current) {
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
      ensureUserDirectoryEntries([userId]);
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
  }, [ensureUserDirectoryEntries]);

  const connectRealtime = useCallback(async () => {
    setError("");

    if (socketRef.current && socketRef.current.connected) {
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

  useEffect(() => {
    connectRealtime();
  }, [connectRealtime]);

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
      if (
        previousConversationId &&
        previousConversationId !== selectedConversationId
      ) {
        await emitWithAck("conversation:leave", {
          conversationId: previousConversationId,
        });
      }

      if (selectedConversationId) {
        const response = await emitWithAck("conversation:join", {
          conversationId: selectedConversationId,
        });
        if (response.ok && Array.isArray(response.onlineUserIds)) {
          setPresenceUsers(response.onlineUserIds);
          ensureUserDirectoryEntries(response.onlineUserIds);
        }
      }

      joinedConversationRef.current = selectedConversationId;
    }

    syncRealtimeRoom();
  }, [selectedConversationId, emitWithAck, ensureUserDirectoryEntries, isRealtimeConnected]);

  const sendMessageHttp = useCallback(
    async (conversationId, body) => {
      const payload = await apiFetch(
        `/api/messages/conversations/${encodeURIComponent(
          conversationId
        )}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        }
      );
      setMessages((prev) => uniqueMessages([...prev, payload.message]));
      return payload.message;
    },
    [apiFetch]
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
          const response = await emitWithAck("message:send", {
            conversationId,
            body,
          });
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
          [conversationId]: (prev[conversationId] || []).filter(
            (userId) => userId !== session.user?.id
          ),
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
    [
      draftMessage,
      selectedConversationId,
      isRealtimeConnected,
      emitWithAck,
      sendMessageHttp,
      session.user?.id,
    ]
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
    [isRealtimeConnected, selectedConversationId, emitWithAck]
  );

  const handleHideConversation = useCallback((conversationId) => {
    if (!conversationId) {
      return;
    }
    setHiddenConversationIds((currentValue) =>
      currentValue.includes(conversationId)
        ? currentValue
        : [...currentValue, conversationId]
    );
  }, []);

  return (
    <div className="page-grid chats-grid">
      <section className="card">
        <div className="section-heading">
          <h2>Conversations</h2>
        </div>

        {isLoadingConversations ? (
          <p className="muted">Loading conversations...</p>
        ) : null}

        <div className="conversation-list">
          {visibleConversations.map((conversation) => (
            <article className="conversation-item-shell" key={conversation.id}>
              <button
                type="button"
                className={
                  conversation.id === selectedConversationId
                    ? "conversation-item active"
                    : "conversation-item"
                }
                onClick={() => setSelectedConversationId(conversation.id)}
              >
                <div className="conversation-title-row">
                  <strong>
                    {formatConversationLabel(
                      conversation,
                      session.user?.id,
                      resolveUserName
                    )}
                  </strong>
                  {conversation.unreadCount > 0 ? (
                    <span className="badge solid">
                      {conversation.unreadCount}
                    </span>
                  ) : null}
                </div>
                <small>
                  {conversation.lastMessage?.body || "No messages yet"}
                </small>
              </button>
              <button
                type="button"
                className="conversation-remove-btn"
                aria-label={`Remove ${formatConversationLabel(
                  conversation,
                  session.user?.id,
                  resolveUserName
                )} from panel`}
                onClick={() => handleHideConversation(conversation.id)}
              >
                Remove
              </button>
            </article>
          ))}
          {visibleConversations.length === 0 ? (
            <p className="muted">
              Start a conversation with a student or group!
            </p>
          ) : null}
        </div>
      </section>

      <section className="card chat-thread-card">
        <div className="section-heading">
          <h2>Messages</h2>
          {selectedConversation && (
            <span className="muted">
              {formatConversationLabel(
                selectedConversation,
                session.user?.id,
                resolveUserName
              )}
            </span>
          )}
        </div>

        {selectedConversationId ? null : (
          <p className="muted">
            Select a conversation to read and send messages.
          </p>
        )}

        {selectedConversationId ? (
          <>
            <div className="presence-row">
              <strong>Online in this chat:</strong>
              <span>
                {presenceUserNames.length > 0
                  ? presenceUserNames.join(", ")
                  : "No one currently online"}
              </span>
            </div>

            {otherTypingUserNames.length > 0 ? (
              <p className="typing-indicator">
                Typing: {otherTypingUserNames.join(", ")}
              </p>
            ) : null}

            <div className="message-list" role="log" aria-live="polite">
              {isLoadingMessages ? (
                <p className="muted">Loading messages...</p>
              ) : null}
              {messages.map((message) => {
                const mine =
                  message.sender_user_id === session.user?.id ||
                  message.senderUserId === session.user?.id;
                const sender = message.sender_user_id || message.senderUserId;
                const created = message.created_at || message.createdAt;
                return (
                  <article
                    className={mine ? "message-bubble mine" : "message-bubble"}
                    key={message.id}
                  >
                    <header>
                      <strong>{mine ? "You" : resolveUserName(sender)}</strong>
                      <small>
                        {created ? new Date(created).toLocaleTimeString() : ""}
                      </small>
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

        {error ? <p className="notice error">{error}</p> : null}
      </section>
    </div>
  );
}
