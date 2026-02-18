import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

function normalizeMembers(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRequests(value) {
  return Array.isArray(value) ? value : [];
}

export default function ClassDetailPage() {
  const { classId } = useParams();
  const navigate = useNavigate();
  const { apiFetch, session } = useAuth();

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

      setNewGroupSectionId((currentValue) => currentValue || (nextSections.length > 0 ? nextSections[0].id : ""));

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

  return (
    <div className="page-grid">
      <section className="card">
        <div className="section-heading">
          <h2>
            {classMeta?.id || classId} {classMeta?.title ? `- ${classMeta.title}` : ""}
          </h2>
          <div className="inline-actions">
            <button className="btn btn-ghost" type="button" onClick={loadClassData}>
              Refresh
            </button>
            <Link className="btn btn-ghost" to="/">
              Back to homepage
            </Link>
          </div>
        </div>
        <p className="muted">Term: {classMeta?.term || "N/A"}</p>
        {isLoading ? <p className="muted">Loading class details...</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
        {info ? <p className="notice success">{info}</p> : null}
      </section>

      <section className="card">
        <h3>Project Sections</h3>
        {sections.length === 0 ? <p className="muted">No project sections yet.</p> : null}
        <div className="stacked-list">
          {sections.map((section) => (
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

        <form className="form-grid" onSubmit={createSection}>
          <h4>Create / Update Project Section</h4>
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

      <section className="card">
        <h3>My Groups</h3>
        {myGroups.length === 0 ? <p className="muted">You are not in a group yet.</p> : null}
        <div className="stacked-list">
          {myGroups.map((group) => {
            const isOwner = (group.owner_user_id || group.ownerUserId) === myUserId;
            return (
              <article className="result-item" key={group.id}>
                <div>
                  <h4>{group.name}</h4>
                  <p>Section: {group.project_section_name || group.project_section}</p>
                  <small>
                    Members: {group.member_count}/{group.max_group_size}
                    {isOwner ? " | You are owner" : ""}
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
      </section>

      <section className="card">
        <h3>Available Groups</h3>
        {availableGroups.length === 0 ? <p className="muted">No available groups found.</p> : null}
        <div className="stacked-list">
          {availableGroups.map((group) => {
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
      </section>

      <section className="card">
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

      <section className="card">
        <h3>My Group Requests to Review</h3>
        {myOwnedGroups.length === 0 ? <p className="muted">You do not own any groups in this class.</p> : null}

        <div className="stacked-list">
          {myOwnedGroups.map((group) => {
            const pending = normalizeRequests(pendingRequestsByGroup[group.id]);
            return (
              <article className="result-item" key={group.id}>
                <div>
                  <h4>{group.name}</h4>
                  <p>Section: {group.project_section_name || group.project_section}</p>
                  <small>Pending requests: {pending.length}</small>
                </div>
                {pending.length === 0 ? (
                  <span className="muted">No pending requests</span>
                ) : (
                  <div className="stacked-list">
                    {pending.map((requestItem) => (
                      <div className="result-item" key={`${group.id}-${requestItem.user_id}`}>
                        <div>
                          <strong>{requestItem.user_id}</strong>
                          <small>{new Date(requestItem.created_at).toLocaleString()}</small>
                        </div>
                        <div className="inline-actions">
                          <button
                            className="btn btn-primary"
                            type="button"
                            onClick={() => approveRequest(group.id, requestItem.user_id)}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-ghost"
                            type="button"
                            onClick={() => rejectRequest(group.id, requestItem.user_id)}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h3>Students in Class</h3>
        {members.length === 0 ? <p className="muted">No students are enrolled yet.</p> : null}
        <ul className="member-list">
          {members.map((member) => {
            const userId = member.user_id;
            return (
              <li key={userId}>
                <div>
                  <span>{userId}</span>
                  <small>{new Date(member.created_at).toLocaleString()}</small>
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
      </section>
    </div>
  );
}
