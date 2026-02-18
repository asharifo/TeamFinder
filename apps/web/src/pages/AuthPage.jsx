import React from "react";
import { useAuth } from "../auth/AuthContext";

export default function AuthPage() {
  const { authConfig, authError, login, signup } = useAuth();
  const authReady = Boolean(authConfig?.auth0Configured);

  return (
    <div className="centered-page">
      <section className="card auth-card">
        <h1>Welcome to TeamFinder</h1>
        <p>
          Find teammates, study groups, and project collaborators in your UBC classes. Sign in to view your class
          workspace.
        </p>

        {authReady ? null : (
          <div className="notice warning">
            Auth0 is not configured in the backend. Update your `.env` and restart services.
          </div>
        )}

        {authError ? <div className="notice error">{authError}</div> : null}

        <div className="auth-actions">
          <button className="btn btn-primary" type="button" onClick={login}>
            Login
          </button>
          <button className="btn btn-secondary" type="button" onClick={signup}>
            Register
          </button>
        </div>
      </section>
    </div>
  );
}
