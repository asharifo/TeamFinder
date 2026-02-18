import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import AppShell from "./components/AppShell";
import AuthPage from "./pages/AuthPage";
import HomePage from "./pages/HomePage";
import ClassDetailPage from "./pages/ClassDetailPage";
import ChatsPage from "./pages/ChatsPage";
import ProfilePage from "./pages/ProfilePage";

function LoadingPage() {
  return (
    <div className="centered-page">
      <div className="card loading-card">
        <h1>TeamFinder</h1>
        <p>Initializing session...</p>
      </div>
    </div>
  );
}

export default function App() {
  const { isInitializing, isAuthenticated } = useAuth();

  if (isInitializing) {
    return <LoadingPage />;
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/classes/:classId" element={<ClassDetailPage />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
