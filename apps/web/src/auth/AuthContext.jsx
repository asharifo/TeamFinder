import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { decodeJwt } from "../lib/jwt";
import { parseResponse, throwIfError } from "../lib/http";
import { generatePkcePair, generateStateToken } from "../lib/pkce";

const AuthContext = createContext(null);

const STORAGE_KEY = "teamfinder.auth";
const PKCE_VERIFIER_KEY = "teamfinder.pkce.verifier";
const PKCE_STATE_KEY = "teamfinder.pkce.state";

function emptySession() {
  return {
    sessionId: "",
    accessToken: "",
    idToken: "",
    expiresAt: 0,
    user: null,
  };
}

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptySession();
    }

    const parsed = JSON.parse(raw);
    return {
      sessionId: parsed.sessionId || "",
      accessToken: "",
      idToken: "",
      expiresAt: 0,
      user: parsed.user || null,
    };
  } catch (_error) {
    return emptySession();
  }
}

function storeSession(session) {
  if (!session.sessionId || !session.user?.id) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      sessionId: session.sessionId,
      user: session.user,
    }),
  );
}

function getUserFromTokens(accessToken, idToken, fallbackUser = null) {
  const idClaims = decodeJwt(idToken);
  const accessClaims = decodeJwt(accessToken);

  const sub = idClaims?.sub || accessClaims?.sub || fallbackUser?.id || "";
  const email = idClaims?.email || accessClaims?.email || fallbackUser?.email || "";
  const name = idClaims?.name || accessClaims?.name || fallbackUser?.name || "";

  if (!sub) {
    return null;
  }

  return {
    id: String(sub),
    email: email ? String(email) : "",
    name: name ? String(name) : "",
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => loadStoredSession());
  const [authConfig, setAuthConfig] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [authError, setAuthError] = useState("");

  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    storeSession(session);
  }, [session]);

  const clearSession = useCallback(() => {
    setSession(emptySession());
  }, []);

  const fetchAuthConfig = useCallback(async () => {
    const response = await fetch("/api/auth/public-config");
    const payload = await parseResponse(response);
    await throwIfError(response, payload);
    setAuthConfig(payload);
    return payload;
  }, []);

  const refreshAccessToken = useCallback(async () => {
    const current = sessionRef.current;
    if (!current.sessionId) {
      return null;
    }

    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: current.sessionId }),
      });

      const payload = await parseResponse(response);
      await throwIfError(response, payload);

      const expiresInSeconds = Number(payload?.tokens?.expiresIn || 0);
      const expiresAt = Date.now() + Math.max(0, expiresInSeconds * 1000 - 30000);
      const user = getUserFromTokens(payload.tokens?.accessToken, payload.tokens?.idToken, current.user);

      if (!user) {
        throw new Error("Unable to determine user from refreshed token");
      }

      setSession((prev) => ({
        ...prev,
        accessToken: payload.tokens.accessToken,
        idToken: payload.tokens.idToken || prev.idToken,
        expiresAt,
        user,
      }));

      return payload.tokens.accessToken;
    } catch (error) {
      clearSession();
      setAuthError(error.message || "Failed to refresh session");
      return null;
    }
  }, [clearSession]);

  const getValidAccessToken = useCallback(async () => {
    const current = sessionRef.current;
    if (!current.sessionId) {
      return null;
    }

    if (current.accessToken && current.expiresAt && Date.now() < current.expiresAt) {
      return current.accessToken;
    }

    return refreshAccessToken();
  }, [refreshAccessToken]);

  const apiFetch = useCallback(
    async (path, options = {}, retryOnce = true) => {
      const token = await getValidAccessToken();

      const headers = {
        ...(options.headers || {}),
      };

      if (options.body !== undefined && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(path, {
        ...options,
        headers,
      });

      const payload = await parseResponse(response);

      if (response.status === 401 && retryOnce && sessionRef.current.sessionId) {
        const refreshedToken = await refreshAccessToken();
        if (refreshedToken) {
          return apiFetch(path, options, false);
        }
      }

      await throwIfError(response, payload);
      return payload;
    },
    [getValidAccessToken, refreshAccessToken],
  );

  const handleAuthCallbackIfPresent = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const callbackState = params.get("state");
    const oauthError = params.get("error");

    if (oauthError) {
      const description = params.get("error_description") || oauthError;
      setAuthError(description);
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    if (!code) {
      return;
    }

    const expectedState = sessionStorage.getItem(PKCE_STATE_KEY) || "";
    const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY) || "";

    sessionStorage.removeItem(PKCE_STATE_KEY);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);

    if (!expectedState || callbackState !== expectedState || !codeVerifier) {
      setAuthError("Invalid authentication state. Please try logging in again.");
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    try {
      const response = await fetch("/api/auth/exchange-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code,
          codeVerifier,
          redirectUri: `${window.location.origin}/`,
        }),
      });

      const payload = await parseResponse(response);
      await throwIfError(response, payload);

      const expiresInSeconds = Number(payload?.tokens?.expiresIn || 0);
      const expiresAt = Date.now() + Math.max(0, expiresInSeconds * 1000 - 30000);
      const user = payload?.session?.user || getUserFromTokens(payload.tokens?.accessToken, payload.tokens?.idToken);

      if (!user?.id) {
        throw new Error("Auth callback did not provide a valid user");
      }

      setSession({
        sessionId: payload.session.id,
        accessToken: payload.tokens.accessToken,
        idToken: payload.tokens.idToken || "",
        expiresAt,
        user: {
          id: String(user.id),
          email: user.email || "",
          name: user.name || "",
        },
      });

      setAuthError("");
    } catch (error) {
      clearSession();
      setAuthError(error.message || "Failed to complete login");
    } finally {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [clearSession]);

  useEffect(() => {
    let isMounted = true;

    async function initialize() {
      try {
        await fetchAuthConfig();
        await handleAuthCallbackIfPresent();

        const current = sessionRef.current;
        if (current.sessionId && (!current.accessToken || !current.expiresAt || Date.now() >= current.expiresAt)) {
          await refreshAccessToken();
        }
      } catch (error) {
        if (isMounted) {
          setAuthError(error.message || "Failed to initialize auth");
        }
      } finally {
        if (isMounted) {
          setIsInitializing(false);
        }
      }
    }

    initialize();

    return () => {
      isMounted = false;
    };
  }, [fetchAuthConfig, handleAuthCallbackIfPresent, refreshAccessToken]);

  const startAuth = useCallback(
    async (screenHint) => {
      const config = authConfig || (await fetchAuthConfig());

      if (!config.auth0Configured) {
        throw new Error("Auth0 is not configured");
      }

      const { verifier, challenge } = await generatePkcePair();
      const stateToken = generateStateToken();

      sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
      sessionStorage.setItem(PKCE_STATE_KEY, stateToken);

      const authorizeUrl = new URL(`https://${config.domain}/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", config.clientId);
      authorizeUrl.searchParams.set("redirect_uri", `${window.location.origin}/`);
      authorizeUrl.searchParams.set("scope", config.scopes || "openid profile email offline_access");
      authorizeUrl.searchParams.set("audience", config.audience);
      authorizeUrl.searchParams.set("state", stateToken);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      if (screenHint) {
        authorizeUrl.searchParams.set("screen_hint", screenHint);
      }

      window.location.assign(authorizeUrl.toString());
    },
    [authConfig, fetchAuthConfig],
  );

  const login = useCallback(async () => {
    setAuthError("");
    try {
      await startAuth();
    } catch (error) {
      setAuthError(error.message || "Failed to start login");
    }
  }, [startAuth]);

  const signup = useCallback(async () => {
    setAuthError("");
    try {
      await startAuth("signup");
    } catch (error) {
      setAuthError(error.message || "Failed to start registration");
    }
  }, [startAuth]);

  const logout = useCallback(async () => {
    const current = sessionRef.current;

    if (current.sessionId) {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId: current.sessionId }),
        });
      } catch (_error) {
      }
    }

    clearSession();
    setAuthError("");
  }, [clearSession]);

  const value = useMemo(
    () => ({
      authConfig,
      authError,
      isInitializing,
      isAuthenticated: Boolean(session.sessionId && session.accessToken && session.user?.id),
      session,
      login,
      signup,
      logout,
      apiFetch,
      getValidAccessToken,
      refreshAccessToken,
    }),
    [authConfig, authError, isInitializing, session, login, signup, logout, apiFetch, getValidAccessToken, refreshAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
