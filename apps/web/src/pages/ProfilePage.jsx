import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";

function normalizeSkills(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

export default function ProfilePage() {
  const { apiFetch, session } = useAuth();

  const [about, setAbout] = useState("");
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillResults, setSkillResults] = useState([]);
  const [profilePictureUrl, setProfilePictureUrl] = useState("");
  const [file, setFile] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const userId = session.user?.id || "";

  const selectedSkillSet = useMemo(() => new Set(selectedSkills), [selectedSkills]);
  const visibleSkillResults = useMemo(
    () => skillResults.filter((skill) => !selectedSkillSet.has(skill)),
    [skillResults, selectedSkillSet],
  );

  const loadProfile = useCallback(async () => {
    if (!userId) {
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const payload = await apiFetch(`/api/profiles/${encodeURIComponent(userId)}`);
      const profile = payload.profile || {};
      setAbout(profile.about || "");
      setSelectedSkills(normalizeSkills(profile.skills));
      setProfilePictureUrl(profile.profile_picture_url || "");
    } catch (profileError) {
      if (profileError.status === 404) {
        setAbout("");
        setSelectedSkills([]);
        setProfilePictureUrl("");
      } else {
        setError(profileError.message || "Failed to load profile");
      }
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, userId]);

  const loadRecommendations = useCallback(async () => {
    if (!userId) {
      return;
    }

    try {
      const payload = await apiFetch(`/api/recommendations/${encodeURIComponent(userId)}?limit=10`);
      setRecommendations(payload.recommendations || []);
    } catch (_error) {
      setRecommendations([]);
    }
  }, [apiFetch, userId]);

  useEffect(() => {
    loadProfile();
    loadRecommendations();
  }, [loadProfile, loadRecommendations]);

  useEffect(() => {
    const handle = setTimeout(async () => {
      setIsLoadingSkills(true);
      try {
        const payload = await apiFetch(
          `/api/profiles/skills/search?q=${encodeURIComponent(skillQuery)}&limit=20`,
        );
        setSkillResults(normalizeSkills(payload.skills));
      } catch (_error) {
        setSkillResults([]);
      } finally {
        setIsLoadingSkills(false);
      }
    }, 180);

    return () => clearTimeout(handle);
  }, [apiFetch, skillQuery]);

  const addSkill = useCallback((skill) => {
    const normalized = String(skill || "").trim();
    if (!normalized) {
      return;
    }
    setSelectedSkills((currentValue) =>
      currentValue.includes(normalized) ? currentValue : [...currentValue, normalized],
    );
    setSkillQuery("");
  }, []);

  const removeSkill = useCallback((skill) => {
    setSelectedSkills((currentValue) => currentValue.filter((value) => value !== skill));
  }, []);

  const saveProfile = useCallback(
    async (event) => {
      event.preventDefault();
      setIsSaving(true);
      setError("");
      setInfo("");

      try {
        let nextProfilePictureUrl = profilePictureUrl;

        if (file) {
          const uploadMeta = await apiFetch(`/api/profiles/${encodeURIComponent(userId)}/picture/upload-url`, {
            method: "POST",
            body: JSON.stringify({ contentType: file.type || "image/jpeg" }),
          });

          const uploadResponse = await fetch(uploadMeta.uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": uploadMeta.contentType,
            },
            body: file,
          });

          if (!uploadResponse.ok) {
            throw new Error(`Upload failed (${uploadResponse.status})`);
          }

          const confirmPayload = await apiFetch(`/api/profiles/${encodeURIComponent(userId)}/picture/confirm`, {
            method: "POST",
            body: JSON.stringify({ objectKey: uploadMeta.objectKey }),
          });

          nextProfilePictureUrl = String(confirmPayload.profilePictureUrl || nextProfilePictureUrl || "").trim();
          setProfilePictureUrl(nextProfilePictureUrl);
          setFile(null);
        }

        await apiFetch(`/api/profiles/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: JSON.stringify({
            about,
            skills: selectedSkills,
            profilePictureUrl: nextProfilePictureUrl,
          }),
        });

        window.dispatchEvent(new Event("teamfinder:profile-updated"));
        setInfo(file ? "Profile and image saved" : "Profile saved");
      } catch (saveError) {
        setError(saveError.message || "Failed to save profile");
      } finally {
        setIsSaving(false);
      }
    },
    [about, apiFetch, file, profilePictureUrl, selectedSkills, userId],
  );

  return (
    <div className="page-grid">
      <section className="card">
        <div className="section-heading">
          <h2>Profile</h2>
        </div>

        {isLoading ? <p className="muted">Loading profile...</p> : null}

        <form className="form-grid" onSubmit={saveProfile}>
          <div className="profile-file-row">
            <label htmlFor="profile-image-upload">Profile picture</label>
            <div className="profile-file-controls">
              <label className="profile-file-picker" htmlFor="profile-image-upload">
                {file ? `Selected: ${file.name}` : "Choose Image"}
              </label>
              <input
                id="profile-image-upload"
                className="profile-file-input"
                type="file"
                accept="image/*"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
              <small className="muted">
                {file ? "Image will upload when you save profile." : "PNG, JPG, WEBP, or GIF"}
              </small>
            </div>
          </div>

          <label>
            About
            <textarea
              rows={4}
              value={about}
              onChange={(event) => setAbout(event.target.value)}
              placeholder="Your study interests, goals, and what kind of teammates you need"
            />
          </label>

          <div className="profile-skills-field">
            <label htmlFor="profile-skills-search">Skills</label>

            {selectedSkills.length > 0 ? (
              <div className="profile-skill-chip-list">
                {selectedSkills.map((skill) => (
                  <span className="profile-skill-chip" key={skill}>
                    {skill}
                    <button type="button" onClick={() => removeSkill(skill)} aria-label={`Remove ${skill}`}>
                      x
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">No skills selected yet.</p>
            )}

            <input
              id="profile-skills-search"
              value={skillQuery}
              onChange={(event) => setSkillQuery(event.target.value)}
              placeholder="Search for your skills"
              autoComplete="off"
            />

            {isLoadingSkills ? <p className="muted">Searching skills...</p> : null}

            {visibleSkillResults.length > 0 ? (
              <div className="profile-skill-results" role="listbox" aria-label="Suggested skills">
                {visibleSkillResults.map((skill) => (
                  <button key={skill} type="button" className="profile-skill-result" onClick={() => addSkill(skill)}>
                    {skill}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button className="btn btn-primary" type="submit" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Profile"}
          </button>
        </form>

        {info ? <p className="notice success">{info}</p> : null}
        {error ? <p className="notice error">{error}</p> : null}
      </section>

      <section className="card">
        <div className="section-heading">
          <h2>Recommended Students</h2>
        </div>

        {recommendations.length === 0 ? <p className="muted">No recommendations yet.</p> : null}

        <div className="stacked-list">
          {recommendations.map((item) => (
            <article className="result-item" key={`${item.user_id}-${item.target_user_id}`}>
              <div>
                <h4>{item.target_user_name || "Unknown Student"}</h4>
                <p>Score: {item.score}</p>
                <small>{Array.isArray(item.reasons) ? item.reasons.join(" | ") : ""}</small>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
