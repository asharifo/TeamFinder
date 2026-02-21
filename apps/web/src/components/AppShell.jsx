import React, { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function AppShell({ children }) {
  const { session, apiFetch, logout } = useAuth();
  const displayName = session.user?.name || session.user?.email?.split("@")[0] || "Member";
  const displayEmail = session.user?.email || session.user?.id || "Signed in";
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const userId = session.user?.id || "";
  const avatarUrl = profileAvatarUrl || session.user?.picture || "";

  const loadProfileAvatar = useCallback(async () => {
    if (!userId) {
      setProfileAvatarUrl("");
      return;
    }

    try {
      const payload = await apiFetch(`/api/profiles/${encodeURIComponent(userId)}`);
      const profile = payload.profile || {};
      const signedViewUrl = String(profile.profile_picture_view_url || "").trim();
      const externalUrl = String(profile.profile_picture_url || "").trim();

      if (signedViewUrl) {
        setProfileAvatarUrl(signedViewUrl);
        return;
      }

      if (externalUrl.startsWith("http://") || externalUrl.startsWith("https://")) {
        setProfileAvatarUrl(externalUrl);
        return;
      }

      setProfileAvatarUrl("");
    } catch (error) {
      if (error?.status === 404) {
        setProfileAvatarUrl("");
      }
    }
  }, [apiFetch, userId]);

  useEffect(() => {
    let isMounted = true;
    async function run() {
      if (!isMounted) {
        return;
      }
      await loadProfileAvatar();
    }

    run();
    return () => {
      isMounted = false;
    };
  }, [loadProfileAvatar]);

  useEffect(() => {
    function handleProfileUpdated() {
      loadProfileAvatar();
    }

    window.addEventListener("teamfinder:profile-updated", handleProfileUpdated);
    return () => {
      window.removeEventListener("teamfinder:profile-updated", handleProfileUpdated);
    };
  }, [loadProfileAvatar]);

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-profile">
          <div className="profile-avatar" aria-hidden="true">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" />
            ) : (
              <span>{initials || "TF"}</span>
            )}
          </div>
          <h2>{displayName}</h2>
          <p>{displayEmail}</p>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "sidebar-link active" : "sidebar-link")}>
            Classes
          </NavLink>
          <NavLink to="/chats" className={({ isActive }) => (isActive ? "sidebar-link active" : "sidebar-link")}>
            Chats
          </NavLink>
          <NavLink to="/profile" className={({ isActive }) => (isActive ? "sidebar-link active" : "sidebar-link")}>
            Profile
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <button className="btn btn-secondary" onClick={logout} type="button">
            Logout
          </button>
        </div>
      </aside>

      <main className="workspace-panel">
        <div className="content-area">{children}</div>
      </main>
    </div>
  );
}
