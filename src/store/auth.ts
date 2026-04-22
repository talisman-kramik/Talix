import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export interface UserData {
  name: string;
  email: string;
  method: "entra" | "biometric";
  microsoftId?: string;
  [key: string]: any;
}

interface AuthState {
  isAuthenticated: boolean;
  user: UserData | null;
  accessToken: string | null;
  loading: boolean;
  isRestoredSession: boolean;
  login: (user: UserData, accessToken?: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const TOKEN_KEY = "auth_access_token";
const USER_KEY = "auth_user";

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  accessToken: null,
  loading: true,
  isRestoredSession: false,

  login: async (user, accessToken) => {
    try {
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
      if (accessToken) {
        await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
      }
      set({ isAuthenticated: true, user, accessToken: accessToken || null, loading: false, isRestoredSession: false });
    } catch (e) {
      console.error("Failed to save auth data", e);
    }
  },

  logout: async () => {
    try {
      await AsyncStorage.removeItem(USER_KEY);
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      set({ isAuthenticated: false, user: null, accessToken: null, loading: false, isRestoredSession: false });
    } catch (e) {
      console.error("Failed to remove auth data", e);
    }
  },

  checkAuth: async () => {
    try {
      set({ loading: true });
      const userData = await AsyncStorage.getItem(USER_KEY);
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (userData) {
        set({
          isAuthenticated: true,
          user: JSON.parse(userData),
          accessToken: token || null,
          loading: false,
          isRestoredSession: true,
        });
      } else {
        set({ isAuthenticated: false, user: null, accessToken: null, loading: false, isRestoredSession: false });
      }
    } catch (e) {
      console.error("Failed to check auth status", e);
      set({ isAuthenticated: false, user: null, accessToken: null, loading: false, isRestoredSession: false });
    }
  },
}));
