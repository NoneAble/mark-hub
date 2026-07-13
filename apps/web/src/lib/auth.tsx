import React, { createContext, useContext, useMemo, useState, useCallback } from "react";
import { createApiClient, type ApiClient } from "@markhub/api-client";

type User = {
  id: string;
  username: string;
  must_change_password: boolean;
};

type AuthCtx = {
  token: string | null;
  user: User | null;
  api: ApiClient;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
  setUser: (u: User | null) => void;
  refreshMe: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);
const TOKEN_KEY = "markhub_token";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(null);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: "/api/v1",
        getToken: () => localStorage.getItem(TOKEN_KEY),
        onUnauthorized: () => {
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setUser(null);
        },
      }),
    [],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<{
        access_token: string;
        user: User;
        must_change_password: boolean;
      }>("/auth/login", { username, password });
      localStorage.setItem(TOKEN_KEY, res.access_token);
      setToken(res.access_token);
      const u = { ...res.user, must_change_password: res.must_change_password };
      setUser(u);
      return u;
    },
    [api],
  );

  const refreshMe = useCallback(async () => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      logout();
    }
  }, [api, logout]);

  React.useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const value = useMemo(
    () => ({ token, user, api, login, logout, setUser, refreshMe }),
    [token, user, api, login, logout, refreshMe],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider missing");
  return v;
}
