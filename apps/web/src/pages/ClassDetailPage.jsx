import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const TAB_ITEMS = [
  { id: "find", label: "Find Groups" },
  { id: "my-groups", label: "My Groups" },
  { id: "students", label: "Students" },
  { id: "create-group", label: "Create Group" },
];

const PAGE_SIZE = {
  availableGroups: 6,
  myGroups: 5,
  requests: 8,
  students: 12,
};

function normalizeMembers(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRequests(value) {
  return Array.isArray(value) ? value : [];
}

function paginateItems(items, page, pageSize) {
  const safeItems = Array.isArray(items) ? items : [];
  const totalPages = Math.max(1, Math.ceil(safeItems.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    page: currentPage,
    totalPages,
    totalItems: safeItems.length,
    items: safeItems.slice(start, start + pageSize),
  };
}

function formatDateTime(value) {
  if (!value) {
    return "Unknown";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

function PaginationControls({ pagination, onPageChange }) {
  if (!pagination || pagination.totalPages <= 1) {
    return null;
  }

  return (
    <div className="pagination-row" role="navigation" aria-label="Pagination">
      <button
        className="btn btn-ghost"
        type="button"
        disabled={pagination.page <= 1}
        onClick={() => onPageChange(pagination.page - 1)}
      >
        Previous
      </button>
      <span className="muted">
        Page {pagination.page} of {pagination.totalPages}
      </span>
      <button
        className="btn btn-ghost"
        type="button"
        disabled={pagination.page >= pagination.totalPages}
        onClick={() => onPageChange(pagination.page + 1)}
      >
        Next
      </button>
    </div>
  );
}

export default function ClassDetailPage() {
  const { classId } = useParams();
  const navigate = useNavigate();
  const { apiFetch, session } = useAuth();

  const [activeTab, setActiveTab] = useState("find");
  const [classMeta, setClassMeta] = useState(null);
  const [members, setMembers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [pendingRequestsByGroup, setPendingRequestsByGroup] = useState({});
  const [newGroupName, setNewGroupName] = useState("");
  const [availableGroupsPage, setAvailableGroupsPage] = useState(1);
  const [myGroupsPage, setMyGroupsPage] = useState(1);
  const [requestPage, setRequestPage] = useState(1);
  const [studentsPage, setStudentsPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const myUserId = session.user?.id || "";

  const myGroups = useMemo(
    () =>
      groups.filter((group) =>
        normalizeMembers(group.members).includes(myUserId)
      ),
    [groups, myUserId]
  );

  const myOwnedGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.owner_user_id === myUserId || group.ownerUserId === myUserId
      ),
    [groups, myUserId]
  );

  const myCreatedGroupsCount = useMemo(
    () => myOwnedGroups.length,
    [myOwnedGroups]
  );
  const reachedCreateLimit = myCreatedGroupsCount >= 5;

  const availableGroups = useMemo(
    () =>
      groups.filter(
        (group) => !normalizeMembers(group.members).includes(myUserId)
      ),
    [groups, myUserId]
  );

  const reviewRequests = useMemo(() => {
    const rows = [];

    for (const group of myOwnedGroups) {
      const pending = normalizeRequests(pendingRequestsByGroup[group.id]);
      for (const requestItem of pending) {
        rows.push({
          ...requestItem,
          groupId: group.id,
          groupName: group.name,
        });
      }
    }

    rows.sort((left, right) => {
      const leftTime = new Date(left.created_at || 0).getTime();
      const rightTime = new Date(right.created_at || 0).getTime();
      return rightTime - leftTime;
    });

    return rows;
  }, [myOwnedGroups, pendingRequestsByGroup]);

  const availableGroupsPagination = useMemo(
    () =>
      paginateItems(
        availableGroups,
        availableGroupsPage,
        PAGE_SIZE.availableGroups
      ),
    [availableGroups, availableGroupsPage]
  );

  const myGroupsPagination = useMemo(
    () => paginateItems(myGroups, myGroupsPage, PAGE_SIZE.myGroups),
    [myGroups, myGroupsPage]
  );

  const requestsPagination = useMemo(
    () => paginateItems(reviewRequests, requestPage, PAGE_SIZE.requests),
    [reviewRequests, requestPage]
  );

  const studentsPagination = useMemo(
    () => paginateItems(members, studentsPage, PAGE_SIZE.students),
    [members, studentsPage]
  );

  const loadOwnerRequests = useCallback(
    async (nextGroups) => {
      const ownedGroupIds = nextGroups
        .filter(
          (group) => (group.owner_user_id || group.ownerUserId) === myUserId
        )
        .map((group) => group.id);

      if (ownedGroupIds.length === 0) {
        setPendingRequestsByGroup({});
        return;
      }

      const entries = await Promise.all(
        ownedGroupIds.map(async (groupId) => {
          try {
            const payload = await apiFetch(
              `/api/classes/groups/${encodeURIComponent(
                groupId
              )}/requests?status=PENDING`
            );
            return [groupId, normalizeRequests(payload.requests)];
          } catch (_error) {
            return [groupId, []];
          }
        })
      );

      setPendingRequestsByGroup(Object.fromEntries(entries));
    },
    [apiFetch, myUserId]
  );

  const loadClassData = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [membersPayload, groupsPayload] = await Promise.all([
        apiFetch(`/api/classes/${encodeURIComponent(classId)}/members`),
        apiFetch(`/api/classes/${encodeURIComponent(classId)}/groups`),
      ]);

      const nextGroups = groupsPayload.groups || [];
      setClassMeta(
        membersPayload.class || { id: classId, title: classId, term: "" }
      );
      setMembers(membersPayload.members || []);
      setGroups(nextGroups);
      await loadOwnerRequests(nextGroups);
    } catch (fetchError) {
      setError(fetchError.message || "Failed to load class details");
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, classId, loadOwnerRequests]);

  useEffect(() => {
    loadClassData();
  }, [loadClassData]);

  const createGroup = useCallback(
    async (event) => {
      event.preventDefault();
      if (reachedCreateLimit) {
        setError("You can create up to 5 groups in this class.");
        return;
      }

      setIsSubmitting(true);
      setError("");
      setInfo("");

      try {
        const payload = await apiFetch(
          `/api/classes/${encodeURIComponent(classId)}/groups`,
          {
            method: "POST",
            body: JSON.stringify({
              name: newGroupName,
            }),
          }
        );

        setInfo(`Created group ${payload.group.name}`);
        setNewGroupName("");
        setActiveTab("my-groups");
        await loadClassData();
      } catch (createError) {
        setError(createError.message || "Failed to create group");
      } finally {
        setIsSubmitting(false);
      }
    },
    [apiFetch, classId, loadClassData, newGroupName, reachedCreateLimit]
  );

  const requestJoin = useCallback(
    async (groupId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(
          `/api/classes/groups/${encodeURIComponent(groupId)}/requests`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );
        setInfo("Join request submitted");
        await loadClassData();
      } catch (requestError) {
        setError(requestError.message || "Failed to request group join");
      }
    },
    [apiFetch, loadClassData]
  );

  const approveRequest = useCallback(
    async (groupId, userId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(
          `/api/classes/groups/${encodeURIComponent(
            groupId
          )}/requests/${encodeURIComponent(userId)}/approve`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );
        setInfo(`Approved request from ${userId}`);
        await loadClassData();
      } catch (approveError) {
        setError(approveError.message || "Failed to approve request");
      }
    },
    [apiFetch, loadClassData]
  );

  const rejectRequest = useCallback(
    async (groupId, userId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(
          `/api/classes/groups/${encodeURIComponent(
            groupId
          )}/requests/${encodeURIComponent(userId)}/reject`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );
        setInfo(`Rejected request from ${userId}`);
        await loadClassData();
      } catch (rejectError) {
        setError(rejectError.message || "Failed to reject request");
      }
    },
    [apiFetch, loadClassData]
  );

  const leaveGroup = useCallback(
    async (groupId) => {
      setError("");
      setInfo("");

      try {
        const payload = await apiFetch(
          `/api/classes/groups/${encodeURIComponent(groupId)}/leave`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );
        setInfo(payload.disbanded ? "Group disbanded" : "You left the group");
        await loadClassData();
      } catch (leaveError) {
        setError(leaveError.message || "Failed to leave group");
      }
    },
    [apiFetch, loadClassData]
  );

  const disbandGroup = useCallback(
    async (groupId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(`/api/classes/groups/${encodeURIComponent(groupId)}`, {
          method: "DELETE",
        });
        setInfo("Group disbanded");
        await loadClassData();
      } catch (deleteError) {
        setError(deleteError.message || "Failed to disband group");
      }
    },
    [apiFetch, loadClassData]
  );

  const openGroupChat = useCallback(
    async (groupId) => {
      setError("");
      try {
        const payload = await apiFetch(
          `/api/messages/conversations/group/${encodeURIComponent(groupId)}`
        );
        navigate(
          `/chats?conversation=${encodeURIComponent(payload.conversation.id)}`
        );
      } catch (chatError) {
        setError(chatError.message || "Unable to open group chat");
      }
    },
    [apiFetch, navigate]
  );

  function renderFindGroupTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Available Groups</h3>
            <span> {availableGroups.length} {availableGroups.length === 1 ? "group" : "groups"}</span>
          </div>

          {availableGroups.length === 0 ? (
            <p className="muted">No available groups yet.</p>
          ) : null}

          <div className="stacked-list">
            {availableGroupsPagination.items.map((group) => {
              const full =
                Number(group.member_count || 0) >=
                Number(group.max_group_size || 0);
              return (
                <article className="result-item" key={group.id}>
                  <div>
                    <h4>{group.name}</h4>
                    <small>
                      Members: {group.member_count}/{group.max_group_size}
                    </small>
                  </div>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={full}
                    onClick={() => requestJoin(group.id)}
                  >
                    {full ? "Full" : "Request Join"}
                  </button>
                </article>
              );
            })}
          </div>

          <PaginationControls
            pagination={availableGroupsPagination}
            onPageChange={setAvailableGroupsPage}
          />
        </section>
      </div>
    );
  }

  function renderMyGroupsTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>My Groups</h3>
            <span className="muted">
              {myGroups.length} {myGroups.length === 1 ? "group" : "groups"}
            </span>
          </div>

          {myGroups.length === 0 ? (
            <p className="muted">You are not in any groups yet.</p>
          ) : null}

          <div className="stacked-list">
            {myGroupsPagination.items.map((group) => {
              const isOwner =
                (group.owner_user_id || group.ownerUserId) === myUserId;
              return (
                <article className="result-item" key={group.id}>
                  <div>
                    <h4>{group.name}</h4>
                    <small>
                      Members: {group.member_count}/{group.max_group_size}
                      {isOwner ? " | Owner" : ""}
                    </small>
                  </div>
                  <div className="inline-actions">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => openGroupChat(group.id)}
                    >
                      Open Chat
                    </button>
                    {isOwner ? (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => disbandGroup(group.id)}
                      >
                        Disband
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => leaveGroup(group.id)}
                      >
                        Leave
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <PaginationControls
            pagination={myGroupsPagination}
            onPageChange={setMyGroupsPage}
          />
        </section>

        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Pending Join Requests</h3>
            <span className="muted">{reviewRequests.length} pending</span>
          </div>

          {myOwnedGroups.length === 0 ? (
            <p className="muted">You do not own any groups in this class.</p>
          ) : null}
          {myOwnedGroups.length > 0 && reviewRequests.length === 0 ? (
            <p className="muted">No pending requests.</p>
          ) : null}

          <div className="stacked-list">
            {requestsPagination.items.map((requestItem) => (
              <article
                className="result-item"
                key={`${requestItem.groupId}-${requestItem.user_id}`}
              >
                <div>
                  <h4>{requestItem.user_id}</h4>
                  <p>Group: {requestItem.groupName}</p>
                  <small>
                    Requested {formatDateTime(requestItem.created_at)}
                  </small>
                </div>
                <div className="inline-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() =>
                      approveRequest(requestItem.groupId, requestItem.user_id)
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() =>
                      rejectRequest(requestItem.groupId, requestItem.user_id)
                    }
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>

          <PaginationControls
            pagination={requestsPagination}
            onPageChange={setRequestPage}
          />
        </section>
      </div>
    );
  }

  function renderCreateGroupTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Create Group</h3>
            <span className="muted">Created {myCreatedGroupsCount}/5</span>
          </div>
          <p className="muted">
            Each student can create up to 5 groups in this class.
          </p>
          <form className="form-grid" onSubmit={createGroup}>
            <label>
              Group name
              <input
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                required
              />
            </label>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={isSubmitting || reachedCreateLimit}
            >
              {reachedCreateLimit ? "Limit Reached" : "Create Group"}
            </button>
          </form>
        </section>
      </div>
    );
  }

  function renderStudentsTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Students in Class</h3>
            <span className="muted">
              {members.length} {members.length === 1 ? "student" : "students"}
            </span>
          </div>

          {members.length === 0 ? (
            <p className="muted">No students are enrolled yet.</p>
          ) : null}

          <ul className="member-list">
            {studentsPagination.items.map((member) => {
              const userId = member.user_id;
              return (
                <li key={userId}>
                  <div>
                    <span>{userId}</span>
                    <small>{formatDateTime(member.created_at)}</small>
                  </div>
                </li>
              );
            })}
          </ul>

          <PaginationControls
            pagination={studentsPagination}
            onPageChange={setStudentsPage}
          />
        </section>
      </div>
    );
  }

  function renderMainTab() {
    if (activeTab === "my-groups") {
      return renderMyGroupsTab();
    }

    if (activeTab === "students") {
      return renderStudentsTab();
    }

    if (activeTab === "create-group") {
      return renderCreateGroupTab();
    }

    return renderFindGroupTab();
  }

  return (
    <div className="class-hub">
      <section className="card class-hub-header">
        <div className="class-hub-title-row">
          <div>
            <h2>
              {classMeta?.id || classId}
              {classMeta?.title ? ` - ${classMeta.title}` : ""}
            </h2>
            <p className="muted">Term: {classMeta?.term || "N/A"}</p>
          </div>
        </div>

        <nav className="class-tab-nav" aria-label="Class workflows">
          {TAB_ITEMS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={
                activeTab === tab.id ? "class-tab-btn active" : "class-tab-btn"
              }
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {isLoading ? <p className="muted">Loading class details...</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
        {info ? <p className="notice success">{info}</p> : null}
      </section>

      <section className="card class-hub-main">{renderMainTab()}</section>
    </div>
  );
}
