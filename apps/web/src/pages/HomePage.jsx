import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function HomePage() {
  const { apiFetch } = useAuth();

  const [enrollments, setEnrollments] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoadingEnrollments, setIsLoadingEnrollments] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const enrolledSet = useMemo(() => new Set(enrollments.map((item) => item.classId)), [enrollments]);

  const loadEnrollments = useCallback(async () => {
    setIsLoadingEnrollments(true);
    setError("");
    try {
      const payload = await apiFetch("/api/classes/enrollments/me");
      setEnrollments(payload.enrollments || []);
    } catch (fetchError) {
      setError(fetchError.message || "Failed to load enrolled classes");
    } finally {
      setIsLoadingEnrollments(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadEnrollments();
  }, [loadEnrollments]);

  const searchClasses = useCallback(async () => {
    setIsSearching(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) {
        params.set("q", searchQuery.trim());
      }
      if (searchTerm.trim()) {
        params.set("term", searchTerm.trim());
      }
      params.set("limit", "50");

      const payload = await apiFetch(`/api/classes?${params.toString()}`);
      setSearchResults(payload.classes || []);
    } catch (searchError) {
      setError(searchError.message || "Class search failed");
    } finally {
      setIsSearching(false);
    }
  }, [apiFetch, searchQuery, searchTerm]);

  const enrollClass = useCallback(
    async (classId) => {
      setInfo("");
      setError("");
      try {
        await apiFetch("/api/classes/enrollments", {
          method: "POST",
          body: JSON.stringify({ classId }),
        });
        setInfo(`Enrolled in ${classId}`);
        await loadEnrollments();
      } catch (enrollError) {
        setError(enrollError.message || "Failed to enroll in class");
      }
    },
    [apiFetch, loadEnrollments],
  );

  return (
    <div className="page-grid">
      <section className="card">
        <div className="section-heading">
          <h2>Your Enlisted Classes</h2>
          <button className="btn btn-ghost" type="button" onClick={loadEnrollments}>
            Refresh
          </button>
        </div>

        {isLoadingEnrollments ? <p className="muted">Loading classes...</p> : null}
        {!isLoadingEnrollments && enrollments.length === 0 ? (
          <p className="muted">No enrollments yet. Search and enroll in classes below.</p>
        ) : null}

        <div className="class-list">
          {enrollments.map((item) => (
            <Link className="class-card" key={item.classId} to={`/classes/${encodeURIComponent(item.classId)}`}>
              <div className="class-card-header">
                <h3>{item.classId}</h3>
                <span className="badge">{item.term}</span>
              </div>
              <p>{item.title}</p>
              <small>Enrolled: {new Date(item.enrolledAt).toLocaleString()}</small>
            </Link>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Find and Enroll Classes</h2>
        <div className="form-grid two-col">
          <label>
            Query
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="e.g. CPSC"
            />
          </label>
          <label>
            Term
            <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="e.g. 2026W" />
          </label>
        </div>
        <button className="btn btn-primary" type="button" onClick={searchClasses} disabled={isSearching}>
          {isSearching ? "Searching..." : "Search classes"}
        </button>

        <div className="search-results">
          {searchResults.map((item) => {
            const alreadyEnrolled = enrolledSet.has(item.id);
            return (
              <article className="result-item" key={item.id}>
                <div>
                  <h3>{item.id}</h3>
                  <p>{item.title}</p>
                  <small>{item.term}</small>
                </div>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={alreadyEnrolled}
                  onClick={() => enrollClass(item.id)}
                >
                  {alreadyEnrolled ? "Enrolled" : "Enroll"}
                </button>
              </article>
            );
          })}
        </div>

        {info ? <p className="notice success">{info}</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </section>
    </div>
  );
}
