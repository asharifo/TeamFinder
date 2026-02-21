import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const TAB_ITEMS = [
  { id: "find", label: "Find Group" },
  { id: "my-group", label: "My Group" },
  { id: "requests", label: "Requests" },
  { id: "sections", label: "Section Settings" },
  { id: "students", label: "Students" },
];

const PAGE_SIZE = {
  availableGroups: 6,
  myGroups: 5,
  requests: 8,
  sections: 6,
  students: 12,
};

function normalizeMembers(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRequests(value) {
  return Array.isArray(value) ? value : [];
}

function getGroupSectionId(group) {
  return String(group.project_section_id || group.projectSectionId || "").trim();
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
  const [selectedSectionId, setSelectedSectionId] = useState("all");
  const [classMeta, setClassMeta] = useState(null);
  const [members, setMembers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [sections, setSections] = useState([]);
  const [pendingRequestsByGroup, setPendingRequestsByGroup] = useState({});
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupSectionId, setNewGroupSectionId] = useState("");
  const [newSectionName, setNewSectionName] = useState("");
  const [newSectionDescription, setNewSectionDescription] = useState("");
  const [newSectionMaxGroupSize, setNewSectionMaxGroupSize] = useState(4);
  const [availableGroupsPage, setAvailableGroupsPage] = useState(1);
  const [myGroupsPage, setMyGroupsPage] = useState(1);
  const [requestPage, setRequestPage] = useState(1);
  const [sectionsPage, setSectionsPage] = useState(1);
  const [studentsPage, setStudentsPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const myUserId = session.user?.id || "";

  const myGroups = useMemo(
    () => groups.filter((group) => normalizeMembers(group.members).includes(myUserId)),
    [groups, myUserId],
  );

  const myOwnedGroups = useMemo(
    () => myGroups.filter((group) => group.owner_user_id === myUserId || group.ownerUserId === myUserId),
    [myGroups, myUserId],
  );

  const availableGroups = useMemo(
    () => groups.filter((group) => !normalizeMembers(group.members).includes(myUserId)),
    [groups, myUserId],
  );

  const filteredAvailableGroups = useMemo(() => {
    if (selectedSectionId === "all") {
      return availableGroups;
    }
    return availableGroups.filter((group) => getGroupSectionId(group) === selectedSectionId);
  }, [availableGroups, selectedSectionId]);

  const filteredMyGroups = useMemo(() => {
    if (selectedSectionId === "all") {
      return myGroups;
    }
    return myGroups.filter((group) => getGroupSectionId(group) === selectedSectionId);
  }, [myGroups, selectedSectionId]);

  const reviewRequests = useMemo(() => {
    const rows = [];

    for (const group of myOwnedGroups) {
      const pending = normalizeRequests(pendingRequestsByGroup[group.id]);
      for (const requestItem of pending) {
        rows.push({
          ...requestItem,
          groupId: group.id,
          groupName: group.name,
          sectionName: group.project_section_name || group.project_section,
          sectionId: getGroupSectionId(group),
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

  const filteredReviewRequests = useMemo(() => {
    if (selectedSectionId === "all") {
      return reviewRequests;
    }
    return reviewRequests.filter((item) => item.sectionId === selectedSectionId);
  }, [reviewRequests, selectedSectionId]);

  const filteredSections = useMemo(() => {
    if (selectedSectionId === "all") {
      return sections;
    }
    return sections.filter((section) => section.id === selectedSectionId);
  }, [sections, selectedSectionId]);

  const selectedSectionMeta = useMemo(
    () => sections.find((section) => section.id === selectedSectionId) || null,
    [sections, selectedSectionId],
  );

  const availableGroupsPagination = useMemo(
    () => paginateItems(filteredAvailableGroups, availableGroupsPage, PAGE_SIZE.availableGroups),
    [filteredAvailableGroups, availableGroupsPage],
  );

  const myGroupsPagination = useMemo(
    () => paginateItems(filteredMyGroups, myGroupsPage, PAGE_SIZE.myGroups),
    [filteredMyGroups, myGroupsPage],
  );

  const requestsPagination = useMemo(
    () => paginateItems(filteredReviewRequests, requestPage, PAGE_SIZE.requests),
    [filteredReviewRequests, requestPage],
  );

  const sectionsPagination = useMemo(
    () => paginateItems(filteredSections, sectionsPage, PAGE_SIZE.sections),
    [filteredSections, sectionsPage],
  );

  const studentsPagination = useMemo(
    () => paginateItems(members, studentsPage, PAGE_SIZE.students),
    [members, studentsPage],
  );

  const loadOwnerRequests = useCallback(
    async (nextGroups) => {
      const ownedGroupIds = nextGroups
        .filter((group) => (group.owner_user_id || group.ownerUserId) === myUserId)
        .map((group) => group.id);

      if (ownedGroupIds.length === 0) {
        setPendingRequestsByGroup({});
        return;
      }

      const entries = await Promise.all(
        ownedGroupIds.map(async (groupId) => {
          try {
            const payload = await apiFetch(`/api/classes/groups/${encodeURIComponent(groupId)}/requests?status=PENDING`);
            return [groupId, normalizeRequests(payload.requests)];
          } catch (_error) {
            return [groupId, []];
          }
        }),
      );

      setPendingRequestsByGroup(Object.fromEntries(entries));
    },
    [apiFetch, myUserId],
  );

  const loadClassData = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [membersPayload, groupsPayload, sectionsPayload] = await Promise.all([
        apiFetch(`/api/classes/${encodeURIComponent(classId)}/members`),
        apiFetch(`/api/classes/${encodeURIComponent(classId)}/groups`),
        apiFetch(`/api/classes/${encodeURIComponent(classId)}/project-sections`),
      ]);

      const nextGroups = groupsPayload.groups || [];
      const nextSections = sectionsPayload.sections || [];

      setClassMeta(membersPayload.class || { id: classId, title: classId, term: "" });
      setMembers(membersPayload.members || []);
      setGroups(nextGroups);
      setSections(nextSections);

      setNewGroupSectionId((currentValue) => {
        if (currentValue && nextSections.some((section) => section.id === currentValue)) {
          return currentValue;
        }
        return nextSections.length > 0 ? nextSections[0].id : "";
      });

      setSelectedSectionId((currentValue) => {
        if (currentValue === "all") {
          return currentValue;
        }
        return nextSections.some((section) => section.id === currentValue) ? currentValue : "all";
      });

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

  useEffect(() => {
    setAvailableGroupsPage(1);
    setMyGroupsPage(1);
    setRequestPage(1);
    setSectionsPage(1);
    setStudentsPage(1);
  }, [selectedSectionId]);

  const createSection = useCallback(
    async (event) => {
      event.preventDefault();
      setIsSubmitting(true);
      setError("");
      setInfo("");

      try {
        const payload = await apiFetch(`/api/classes/${encodeURIComponent(classId)}/project-sections`, {
          method: "POST",
          body: JSON.stringify({
            name: newSectionName,
            description: newSectionDescription,
            maxGroupSize: Number(newSectionMaxGroupSize || 4),
          }),
        });

        setInfo(`Project section ${payload.section.name} saved`);
        setNewSectionName("");
        setNewSectionDescription("");
        setNewSectionMaxGroupSize(4);
        await loadClassData();
      } catch (sectionError) {
        setError(sectionError.message || "Failed to save project section");
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      apiFetch,
      classId,
      loadClassData,
      newSectionDescription,
      newSectionMaxGroupSize,
      newSectionName,
    ],
  );

  const createGroup = useCallback(
    async (event) => {
      event.preventDefault();
      setIsSubmitting(true);
      setError("");
      setInfo("");

      try {
        const payload = await apiFetch(`/api/classes/${encodeURIComponent(classId)}/groups`, {
          method: "POST",
          body: JSON.stringify({
            name: newGroupName,
            projectSectionId: newGroupSectionId,
          }),
        });

        setInfo(`Created group ${payload.group.name}`);
        setNewGroupName("");
        await loadClassData();
      } catch (createError) {
        setError(createError.message || "Failed to create group");
      } finally {
        setIsSubmitting(false);
      }
    },
    [apiFetch, classId, loadClassData, newGroupName, newGroupSectionId],
  );

  const requestJoin = useCallback(
    async (groupId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(`/api/classes/groups/${encodeURIComponent(groupId)}/requests`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setInfo("Join request submitted");
        await loadClassData();
      } catch (requestError) {
        setError(requestError.message || "Failed to request group join");
      }
    },
    [apiFetch, loadClassData],
  );

  const approveRequest = useCallback(
    async (groupId, userId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(
          `/api/classes/groups/${encodeURIComponent(groupId)}/requests/${encodeURIComponent(userId)}/approve`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        );
        setInfo(`Approved request from ${userId}`);
        await loadClassData();
      } catch (approveError) {
        setError(approveError.message || "Failed to approve request");
      }
    },
    [apiFetch, loadClassData],
  );

  const rejectRequest = useCallback(
    async (groupId, userId) => {
      setError("");
      setInfo("");

      try {
        await apiFetch(
          `/api/classes/groups/${encodeURIComponent(groupId)}/requests/${encodeURIComponent(userId)}/reject`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        );
        setInfo(`Rejected request from ${userId}`);
        await loadClassData();
      } catch (rejectError) {
        setError(rejectError.message || "Failed to reject request");
      }
    },
    [apiFetch, loadClassData],
  );

  const leaveGroup = useCallback(
    async (groupId) => {
      setError("");
      setInfo("");

      try {
        const payload = await apiFetch(`/api/classes/groups/${encodeURIComponent(groupId)}/leave`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setInfo(payload.disbanded ? "Group disbanded" : "You left the group");
        await loadClassData();
      } catch (leaveError) {
        setError(leaveError.message || "Failed to leave group");
      }
    },
    [apiFetch, loadClassData],
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
    [apiFetch, loadClassData],
  );

  const openGroupChat = useCallback(
    async (groupId) => {
      setError("");
      try {
        const payload = await apiFetch(`/api/messages/conversations/group/${encodeURIComponent(groupId)}`);
        navigate(`/chats?conversation=${encodeURIComponent(payload.conversation.id)}`);
      } catch (chatError) {
        setError(chatError.message || "Unable to open group chat");
      }
    },
    [apiFetch, navigate],
  );

  const startDirectMessage = useCallback(
    async (targetUserId) => {
      setError("");
      if (!targetUserId || targetUserId === myUserId) {
        return;
      }

      try {
        const payload = await apiFetch("/api/messages/conversations/dm", {
          method: "POST",
          body: JSON.stringify({ otherUserId: targetUserId }),
        });

        navigate(`/chats?conversation=${encodeURIComponent(payload.conversation.id)}`);
      } catch (dmError) {
        setError(dmError.message || "Unable to start direct message");
      }
    },
    [apiFetch, myUserId, navigate],
  );

  const primaryAction = useMemo(() => {
    if (activeTab === "find") {
      return {
        label: "Create Group",
        onClick: () => setActiveTab("my-group"),
      };
    }

    if (activeTab === "my-group") {
      return {
        label: "Find Groups",
        onClick: () => setActiveTab("find"),
      };
    }

    return {
      label: "Find Groups",
      onClick: () => setActiveTab("find"),
    };
  }, [activeTab]);

  const contextHint = useMemo(() => {
    if (activeTab === "find") {
      return "Browse open groups and send one join request at a time.";
    }
    if (activeTab === "my-group") {
      return "Manage your current group and use chat for team coordination.";
    }
    if (activeTab === "requests") {
      return "Approve or reject pending join requests for groups you own.";
    }
    if (activeTab === "sections") {
      return "Define project sections and expected group sizes.";
    }
    return "Message classmates directly to coordinate outside group workflows.";
  }, [activeTab]);

  function renderFindGroupTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Available Groups</h3>
            <span className="muted">{filteredAvailableGroups.length} groups</span>
          </div>

          {filteredAvailableGroups.length === 0 ? (
            <p className="muted">
              {selectedSectionId === "all" ? "No available groups yet." : "No available groups found in this section."}
            </p>
          ) : null}

          <div className="stacked-list">
            {availableGroupsPagination.items.map((group) => {
              const full = Number(group.member_count || 0) >= Number(group.max_group_size || 0);
              return (
                <article className="result-item" key={group.id}>
                  <div>
                    <h4>{group.name}</h4>
                    <p>Section: {group.project_section_name || group.project_section}</p>
                    <small>
                      Members: {group.member_count}/{group.max_group_size}
                    </small>
                  </div>
                  <button className="btn btn-secondary" type="button" disabled={full} onClick={() => requestJoin(group.id)}>
                    {full ? "Full" : "Request Join"}
                  </button>
                </article>
              );
            })}
          </div>

          <PaginationControls pagination={availableGroupsPagination} onPageChange={setAvailableGroupsPage} />
        </section>
      </div>
    );
  }

  function renderMyGroupTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>My Groups</h3>
            <span className="muted">{filteredMyGroups.length} groups</span>
          </div>

          {filteredMyGroups.length === 0 ? <p className="muted">You are not in a group for this section yet.</p> : null}

          <div className="stacked-list">
            {myGroupsPagination.items.map((group) => {
              const isOwner = (group.owner_user_id || group.ownerUserId) === myUserId;
              return (
                <article className="result-item" key={group.id}>
                  <div>
                    <h4>{group.name}</h4>
                    <p>Section: {group.project_section_name || group.project_section}</p>
                    <small>
                      Members: {group.member_count}/{group.max_group_size}
                      {isOwner ? " | Owner" : ""}
                    </small>
                  </div>
                  <div className="inline-actions">
                    <button className="btn btn-secondary" type="button" onClick={() => openGroupChat(group.id)}>
                      Open Chat
                    </button>
                    {isOwner ? (
                      <button className="btn btn-ghost" type="button" onClick={() => disbandGroup(group.id)}>
                        Disband
                      </button>
                    ) : (
                      <button className="btn btn-ghost" type="button" onClick={() => leaveGroup(group.id)}>
                        Leave
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <PaginationControls pagination={myGroupsPagination} onPageChange={setMyGroupsPage} />
        </section>

        <section className="class-flow-block">
          <h3>Create Group</h3>
          <form className="form-grid" onSubmit={createGroup}>
            <label>
              Group name
              <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} required />
            </label>
            <label>
              Project section
              <select
                value={newGroupSectionId}
                onChange={(event) => setNewGroupSectionId(event.target.value)}
                required
                disabled={sections.length === 0}
              >
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.name} (max {section.max_group_size})
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="submit" disabled={isSubmitting || sections.length === 0}>
              Create Group
            </button>
          </form>
        </section>
      </div>
    );
  }

  function renderRequestsTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Pending Join Requests</h3>
            <span className="muted">{filteredReviewRequests.length} pending</span>
          </div>

          {myOwnedGroups.length === 0 ? <p className="muted">You do not own any groups in this class.</p> : null}
          {myOwnedGroups.length > 0 && filteredReviewRequests.length === 0 ? (
            <p className="muted">No pending requests in this section.</p>
          ) : null}

          <div className="stacked-list">
            {requestsPagination.items.map((requestItem) => (
              <article className="result-item" key={`${requestItem.groupId}-${requestItem.user_id}`}>
                <div>
                  <h4>{requestItem.user_id}</h4>
                  <p>Group: {requestItem.groupName}</p>
                  <small>
                    Section: {requestItem.sectionName || "Unassigned"} | Requested {formatDateTime(requestItem.created_at)}
                  </small>
                </div>
                <div className="inline-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => approveRequest(requestItem.groupId, requestItem.user_id)}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => rejectRequest(requestItem.groupId, requestItem.user_id)}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>

          <PaginationControls pagination={requestsPagination} onPageChange={setRequestPage} />
        </section>
      </div>
    );
  }

  function renderSectionsTab() {
    return (
      <div className="class-flow-stack">
        <section className="class-flow-block">
          <div className="section-heading">
            <h3>Project Sections</h3>
            <span className="muted">{filteredSections.length} sections</span>
          </div>

          {filteredSections.length === 0 ? <p className="muted">No project sections yet.</p> : null}

          <div className="stacked-list">
            {sectionsPagination.items.map((section) => (
              <article className="result-item" key={section.id}>
                <div>
                  <h4>{section.name}</h4>
                  <p>{section.description || "No description"}</p>
                  <small>
                    Max group size: {section.max_group_size} | Groups: {section.group_count}
                  </small>
                </div>
              </article>
            ))}
          </div>

          <PaginationControls pagination={sectionsPagination} onPageChange={setSectionsPage} />
        </section>

        <section className="class-flow-block">
          <h3>Create / Update Project Section</h3>
          <form className="form-grid" onSubmit={createSection}>
            <label>
              Name
              <input value={newSectionName} onChange={(event) => setNewSectionName(event.target.value)} required />
            </label>
            <label>
              Description
              <input
                value={newSectionDescription}
                onChange={(event) => setNewSectionDescription(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label>
              Max group size
              <input
                type="number"
                min={2}
                max={20}
                value={newSectionMaxGroupSize}
                onChange={(event) => setNewSectionMaxGroupSize(event.target.value)}
                required
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
              Save Section
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
            <span className="muted">{members.length} students</span>
          </div>

          {members.length === 0 ? <p className="muted">No students are enrolled yet.</p> : null}

          <ul className="member-list">
            {studentsPagination.items.map((member) => {
              const userId = member.user_id;
              return (
                <li key={userId}>
                  <div>
                    <span>{userId}</span>
                    <small>{formatDateTime(member.created_at)}</small>
                  </div>
                  {userId !== myUserId ? (
                    <button className="btn btn-secondary" type="button" onClick={() => startDirectMessage(userId)}>
                      Message
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <PaginationControls pagination={studentsPagination} onPageChange={setStudentsPage} />
        </section>
      </div>
    );
  }

  function renderMainTab() {
    if (activeTab === "my-group") {
      return renderMyGroupTab();
    }

    if (activeTab === "requests") {
      return renderRequestsTab();
    }

    if (activeTab === "sections") {
      return renderSectionsTab();
    }

    if (activeTab === "students") {
      return renderStudentsTab();
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
          <div className="class-hub-header-actions">
            <label className="class-filter-control">
              Section
              <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)}>
                <option value="all">All sections</option>
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="button" onClick={primaryAction.onClick}>
              {primaryAction.label}
            </button>
            <Link className="btn btn-ghost" to="/">
              Back to classes
            </Link>
          </div>
        </div>

        <nav className="class-tab-nav" aria-label="Class workflows">
          {TAB_ITEMS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "class-tab-btn active" : "class-tab-btn"}
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

      <div className="class-hub-grid">
        <section className="card class-hub-main">{renderMainTab()}</section>

        <aside className="card class-hub-context">
          <h3>Class Overview</h3>
          <p className="muted">{contextHint}</p>

          <div className="class-context-stats">
            <article className="class-context-stat">
              <span className="muted">Project Sections</span>
              <strong>{sections.length}</strong>
            </article>
            <article className="class-context-stat">
              <span className="muted">Groups</span>
              <strong>{groups.length}</strong>
            </article>
            <article className="class-context-stat">
              <span className="muted">Open Groups</span>
              <strong>{filteredAvailableGroups.length}</strong>
            </article>
            <article className="class-context-stat">
              <span className="muted">My Groups</span>
              <strong>{filteredMyGroups.length}</strong>
            </article>
            <article className="class-context-stat">
              <span className="muted">Pending Requests</span>
              <strong>{filteredReviewRequests.length}</strong>
            </article>
            <article className="class-context-stat">
              <span className="muted">Students</span>
              <strong>{members.length}</strong>
            </article>
          </div>

          {selectedSectionMeta ? (
            <div className="class-context-section-meta">
              <h4>{selectedSectionMeta.name}</h4>
              <p>{selectedSectionMeta.description || "No description"}</p>
              <small>
                Max group size: {selectedSectionMeta.max_group_size} | Groups: {selectedSectionMeta.group_count}
              </small>
            </div>
          ) : (
            <p className="muted">Select a section filter for focused workflows.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
