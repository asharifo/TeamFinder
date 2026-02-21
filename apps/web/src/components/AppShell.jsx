import React from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function AppShell({ children }) {
  const { session, logout } = useAuth();
  const displayName = session.user?.name || session.user?.email?.split("@")[0] || "Member";
  const displayEmail = session.user?.email || session.user?.id || "Signed in";
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-profile">
          <div className="profile-avatar" aria-hidden="true">
            {session.user?.picture ? (
              <img src={session.user.picture} alt="" />
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
          <div className="user-chip">
            <span className="label">Workspace</span>
            <strong>TeamFinder</strong>
          </div>
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
