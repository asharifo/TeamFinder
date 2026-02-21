import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import ClassSectionCard from "../components/ClassSectionCard";

function normalizeClassSection(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const classId = String(item.classId || item.class_id || item.id || "")
    .trim()
    .toUpperCase();
  if (!classId) {
    return null;
  }

  return {
    classId,
    title: String(item.title || item.name || classId).trim(),
    term: String(item.term || item.section || "").trim(),
    description: String(item.description || "").trim(),
    enrolledAt: item.enrolledAt || item.enrolled_at || item.created_at || "",
  };
}

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
  const accentClasses = ["accent-cyan", "accent-violet", "accent-amber", "accent-emerald"];

  const enrolledSet = useMemo(() => new Set(enrollments.map((item) => item.classId)), [enrollments]);

  const loadEnrollments = useCallback(async () => {
    setIsLoadingEnrollments(true);
    setError("");
    try {
      const payload = await apiFetch("/api/classes/enrollments/me");
      const normalized = (payload.enrollments || []).map(normalizeClassSection).filter(Boolean);
      setEnrollments(normalized);
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
      const normalized = (payload.classes || []).map(normalizeClassSection).filter(Boolean);
      setSearchResults(normalized);
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
    <div className="dashboard-shell">
      <section className="dashboard-pane classes-pane">
        <div className="section-heading dashboard-heading">
          <h2>Classes</h2>
        </div>

        {isLoadingEnrollments ? <p className="muted">Loading classes...</p> : null}
        {!isLoadingEnrollments && enrollments.length === 0 ? (
          <p className="muted">No enrollments yet. Search and enroll in classes below.</p>
        ) : null}

        <div className="enrollment-list">
          {enrollments.map((item, index) => (
            <ClassSectionCard
              key={item.classId}
              to={`/classes/${encodeURIComponent(item.classId)}`}
              classId={item.classId}
              title={item.title}
              term={item.term}
              description={item.description}
              meta={item.enrolledAt ? `Enrolled: ${new Date(item.enrolledAt).toLocaleString()}` : ""}
              accentClass={accentClasses[index % accentClasses.length]}
              className="enrollment-row"
            />
          ))}
        </div>
      </section>

      <section className="dashboard-pane finder-pane">
        <h2 className="finder-title">Find Class Sections</h2>
        <div className="form-grid two-col">
          <label>
            Class Name
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
          {searchResults.map((item, index) => {
            const alreadyEnrolled = enrolledSet.has(item.classId);
            return (
              <ClassSectionCard
                key={`${item.classId}-${item.term || "term"}`}
                classId={item.classId}
                title={item.title}
                term={item.term}
                description={item.description}
                accentClass={accentClasses[index % accentClasses.length]}
                className="result-item"
                action={
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={alreadyEnrolled}
                    onClick={() => enrollClass(item.classId)}
                  >
                    {alreadyEnrolled ? "Enrolled" : "Enroll"}
                  </button>
                }
              />
            );
          })}
        </div>

        {info ? <p className="notice success">{info}</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </section>
    </div>
  );
}
