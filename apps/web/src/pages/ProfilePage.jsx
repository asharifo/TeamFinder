import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";

function toCsv(value) {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.join(", ");
}

function fromCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function ProfilePage() {
  const { apiFetch, session } = useAuth();

  const [form, setForm] = useState({
    about: "",
    skillsCsv: "",
    classesCsv: "",
    availability: "",
    profilePictureUrl: "",
  });
  const [file, setFile] = useState(null);
  const [profilePicturePreviewUrl, setProfilePicturePreviewUrl] = useState("");
  const [recommendations, setRecommendations] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const userId = session.user?.id || "";

  const previewImageUrl = useMemo(() => {
    if (form.profilePictureUrl.startsWith("http://") || form.profilePictureUrl.startsWith("https://")) {
      return form.profilePictureUrl;
    }
    return profilePicturePreviewUrl;
  }, [form.profilePictureUrl, profilePicturePreviewUrl]);

  const loadProfile = useCallback(async () => {
    if (!userId) {
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const payload = await apiFetch(`/api/profiles/${encodeURIComponent(userId)}`);
      const profile = payload.profile;
      setForm({
        about: profile.about || "",
        skillsCsv: toCsv(profile.skills),
        classesCsv: toCsv(profile.classes),
        availability: profile.availability || "",
        profilePictureUrl: profile.profile_picture_url || "",
      });
      setProfilePicturePreviewUrl(profile.profile_picture_view_url || "");
    } catch (profileError) {
      if (profileError.status === 404) {
        setForm({
          about: "",
          skillsCsv: "",
          classesCsv: "",
          availability: "",
          profilePictureUrl: "",
        });
        setProfilePicturePreviewUrl("");
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

  const updateFormField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const saveProfile = useCallback(
    async (event) => {
      event.preventDefault();
      setIsSaving(true);
      setError("");
      setInfo("");

      try {
        const payload = await apiFetch(`/api/profiles/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: JSON.stringify({
            about: form.about,
            skills: fromCsv(form.skillsCsv),
            classes: fromCsv(form.classesCsv),
            availability: form.availability,
            profilePictureUrl: form.profilePictureUrl,
          }),
        });

        const savedProfile = payload.profile || {};
        setProfilePicturePreviewUrl(savedProfile.profile_picture_view_url || "");
        window.dispatchEvent(new Event("teamfinder:profile-updated"));
        setInfo("Profile saved");
      } catch (saveError) {
        setError(saveError.message || "Failed to save profile");
      } finally {
        setIsSaving(false);
      }
    },
    [apiFetch, form, userId],
  );

  const uploadPicture = useCallback(async () => {
    if (!file) {
      setError("Select an image first");
      return;
    }

    setError("");
    setInfo("");

    try {
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

      updateFormField("profilePictureUrl", confirmPayload.profilePictureUrl || "");
      setProfilePicturePreviewUrl(confirmPayload.profilePictureViewUrl || "");
      window.dispatchEvent(new Event("teamfinder:profile-updated"));
      setInfo("Profile image uploaded");
      setFile(null);
    } catch (uploadError) {
      setError(uploadError.message || "Failed to upload profile image");
    }
  }, [apiFetch, file, userId, updateFormField]);

  return (
    <div className="page-grid">
      <section className="card">
        <div className="section-heading">
          <h2>Profile</h2>
        </div>

        {isLoading ? <p className="muted">Loading profile...</p> : null}

        <form className="form-grid" onSubmit={saveProfile}>
          <label>
            About
            <textarea
              rows={4}
              value={form.about}
              onChange={(event) => updateFormField("about", event.target.value)}
              placeholder="Your study interests, goals, and what kind of teammates you need"
            />
          </label>

          <label>
            Skills (comma separated)
            <input
              value={form.skillsCsv}
              onChange={(event) => updateFormField("skillsCsv", event.target.value)}
              placeholder="e.g. Java, React, SQL"
            />
          </label>

          <label>
            Classes (comma separated)
            <input
              value={form.classesCsv}
              onChange={(event) => updateFormField("classesCsv", event.target.value)}
              placeholder="e.g. CPSC210, CPSC221"
            />
          </label>

          <label>
            Availability
            <input
              value={form.availability}
              onChange={(event) => updateFormField("availability", event.target.value)}
              placeholder="e.g. Weekdays after 5pm"
            />
          </label>

          <label>
            Profile image URL
            <input
              value={form.profilePictureUrl}
              onChange={(event) => updateFormField("profilePictureUrl", event.target.value)}
              placeholder="s3://... or https://..."
            />
          </label>

          <button className="btn btn-primary" type="submit" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Profile"}
          </button>
        </form>

        <div className="upload-row">
          <label>
            Upload image
            <input type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <button className="btn btn-secondary" type="button" onClick={uploadPicture} disabled={!file}>
            Upload
          </button>
        </div>

        {previewImageUrl ? <img src={previewImageUrl} alt="Profile" className="profile-preview" /> : null}

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
                <h4>{item.target_user_id}</h4>
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
