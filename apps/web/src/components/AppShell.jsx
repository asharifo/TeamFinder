import React from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function AppShell({ children }) {
  const { session, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1>TeamFinder</h1>
          <p>UBC team and study-group matching</p>
        </div>
        <div className="header-meta">
          <div className="user-chip">
            <span className="label">Signed in as</span>
            <strong>{session.user?.name || session.user?.email || session.user?.id}</strong>
          </div>
          <button className="btn btn-secondary" onClick={logout} type="button">
            Logout
          </button>
        </div>
      </header>

      <nav className="top-nav" aria-label="Main navigation">
        <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
          Homepage
        </NavLink>
        <NavLink to="/chats" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
          Chats
        </NavLink>
        <NavLink to="/profile" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
          Profile
        </NavLink>
      </nav>

      <main className="content-area">{children}</main>
    </div>
  );
}
