/**
 * Talix — Mobile App
 *
 * Cross-platform (iPhone, iPad, Android) medical documentation app.
 * Connects to the same FastAPI backend as the web app.
 *
 * Auth flow:
 *  1. Not logged in  → LoginScreen (Microsoft SSO only)
 *  2. Logged in + app locked (background → foreground) → BiometricLockScreen
 *  3. Logged in + unlocked → Main app tabs
 */
import React, { useEffect, useRef, useState } from "react";
import { View, ActivityIndicator, Text, StyleSheet, AppState, AppStateStatus } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";

import LoginScreen from "./src/screens/LoginScreen";
import BiometricLockScreen from "./src/screens/BiometricLockScreen";
import RecordScreen from "./src/screens/RecordScreen";
import EncountersScreen from "./src/screens/EncountersScreen";
import EncounterDetailScreen from "./src/screens/EncounterDetailScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import { colors, fontSize, spacing } from "./src/lib/theme";
import { useSettings } from "./src/store/settings";
import { useOfflineStore } from "./src/store/offline";
import { useAuthStore } from "./src/store/auth";

const EncounterStack = createNativeStackNavigator();

function EncountersStackScreen() {
  return (
    <EncounterStack.Navigator
      screenOptions={{
        headerTintColor: colors.brand,
        headerStyle: { backgroundColor: colors.card },
      }}
    >
      <EncounterStack.Screen
        name="EncountersList"
        component={EncountersScreen}
        options={{ title: "Encounters" }}
      />
      <EncounterStack.Screen
        name="EncounterDetail"
        component={EncounterDetailScreen}
        options={{ title: "Encounter" }}
      />
    </EncounterStack.Navigator>
  );
}

const Tab = createBottomTabNavigator();

export default function App() {
  const loadSettings = useSettings((s) => s.load);
  const loadedSettings = useSettings((s) => s.loaded);
  const loadOffline = useOfflineStore((s) => s.load);
  const processQueue = useOfflineStore((s) => s.processQueue);

  const checkAuth = useAuthStore((s) => s.checkAuth);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loadingAuth = useAuthStore((s) => s.loading);
  const isRestoredSession = useAuthStore((s) => s.isRestoredSession);
  const user = useAuthStore((s) => s.user);

  // ── Biometric lock state ──────────────────────────────────────────────
  // Start locked — will unlock via biometric if user has an active session,
  // or show login screen if not authenticated.
  const [isLocked, setIsLocked] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  // Track when the app went to background to avoid locking on brief interruptions
  const backgroundedAt = useRef<number | null>(null);
  // Lock after 30 seconds in background
  const LOCK_AFTER_SECONDS = 30;

  useEffect(() => {
    checkAuth();
    loadSettings();
    loadOffline().then(() => processQueue());

    // Check if device supports biometrics
    (async () => {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(compatible && enrolled);
    })();
  }, []);

  // ── Lock the app when it goes to background and comes back ───────────
  useEffect(() => {
    if (!biometricAvailable) return;

    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      const prev = appState.current;
      appState.current = nextState;

      if (prev === "active" && (nextState === "background" || nextState === "inactive")) {
        // App went to background — record time
        backgroundedAt.current = Date.now();
      }

      if ((prev === "background" || prev === "inactive") && nextState === "active") {
        // App came to foreground
        if (isAuthenticated && backgroundedAt.current !== null) {
          const secondsInBackground = (Date.now() - backgroundedAt.current) / 1000;
          if (secondsInBackground >= LOCK_AFTER_SECONDS) {
            setIsLocked(true);
          }
        }
        backgroundedAt.current = null;
      }
    });

    return () => subscription.remove();
  }, [biometricAvailable, isAuthenticated]);

  // When authentication changes, lock or unlock based on session type
  useEffect(() => {
    if (isAuthenticated) {
      if (isRestoredSession) {
        // App restarted from killed state with saved session → Lock it
        setIsLocked(true);
      } else {
        // Fresh login directly from Microsoft SSO → Unlock immediately
        setIsLocked(false);
      }
    } else {
      // Not authenticated (e.g. logged out) → Lock resets
      setIsLocked(true);
    }
  }, [isAuthenticated, isRestoredSession]);

  // ── Loading splash ────────────────────────────────────────────────────
  if (!loadedSettings || loadingAuth) {
    return (
      <View style={splashStyles.container}>
        <ActivityIndicator size="large" color={colors.brand} />
        <Text style={splashStyles.text}>Loading...</Text>
      </View>
    );
  }

  // ── Not logged in → Microsoft Login ──────────────────────────────────
  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // ── Logged in but app locked → Biometric gate ─────────────────────────
  if (isLocked && biometricAvailable) {
    return (
      <BiometricLockScreen
        userName={user?.name}
        onUnlock={() => setIsLocked(false)}
      />
    );
  }

  // ── Authenticated + Unlocked → Main app ──────────────────────────────
  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: route.name !== "Encounters",
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.text,
          tabBarActiveTintColor: colors.brand,
          tabBarInactiveTintColor: colors.textTertiary,
          tabBarStyle: {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
          },
          tabBarIcon: ({ color, size }) => {
            const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
              Record: "mic",
              Encounters: "list",
              Settings: "settings",
            };
            return <Ionicons name={icons[route.name] ?? "ellipse"} size={size} color={color} />;
          },
        })}
      >
        <Tab.Screen name="Record" component={RecordScreen} />
        <Tab.Screen
          name="Encounters"
          component={EncountersStackScreen}
          options={{ headerShown: false }}
        />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const splashStyles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.bg },
  text: { marginTop: spacing.md, fontSize: fontSize.sm, color: colors.textSecondary },
});
