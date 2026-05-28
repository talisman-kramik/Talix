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
import { useProviders } from "./src/store/providers";
import {
  getCachedPatients,
  setCachedPatients,
} from "./src/store/patientsCache";
import { setCachedSamples } from "./src/store/samplesCache";
import { findProviderForUser } from "./src/lib/providerMatch";
import {
  fetchPatientsByProviderDate,
  fetchProviders,
  fetchSamples,
  type EclipseLocation,
} from "./src/lib/api";

const EncounterStack = createNativeStackNavigator();

function EncountersStackScreen() {
  return (
    <EncounterStack.Navigator
      screenOptions={{
        headerTintColor: colors.brand,
        headerStyle: { backgroundColor: colors.card },
      }}
    >
      {/* List view renders its own in-screen heading, so hide the stack
          header here to avoid duplicate "SOAP Notes" titles. */}
      <EncounterStack.Screen
        name="EncountersList"
        component={EncountersScreen}
        options={{ headerShown: false }}
      />
      {/* Detail view keeps the stack header so users get a back button.
          `headerBackButtonDisplayMode: "minimal"` drops the previous-screen
          label ("SOAP Notes") next to the chevron so the only title shown
          is the centered "SOAP Note" page title. */}
      <EncounterStack.Screen
        name="EncounterDetail"
        component={EncounterDetailScreen}
        options={{
          title: "SOAP Note",
          headerBackButtonDisplayMode: "minimal",
        }}
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

  // Pre-warm the providers store for the currently selected location so the
  // Record / SOAP Notes screens don't pay the Eclipse round-trip on first
  // mount. Re-warms on location switch (PA ↔ Baltimore). Failures are
  // swallowed — each screen still surfaces its own error UI.
  const eclipseLocation = useSettings((s) => s.eclipseLocation);
  useEffect(() => {
    // Hydration from disk runs on every location change AND on cold start.
    // We persist each location's snapshot separately (PA + Baltimore live
    // in their own AsyncStorage keys) so flipping between them paints the
    // dropdown instantly from cache while the background Eclipse refresh
    // runs in parallel — never blank, never spinner.
    useProviders.getState().hydrateFromCache(eclipseLocation).catch(() => {});
  }, [eclipseLocation]);
  useEffect(() => {
    if (!isAuthenticated) return;
    useProviders.getState().loadProviders(eclipseLocation).catch(() => {});
  }, [isAuthenticated, eclipseLocation]);

  // ─────────────────────────────────────────────────────────────────────
  // Login warmup: parallel background prefetch of *everything* the user
  // is likely to look at in the next minute. By the time they tap any
  // tab, the data is already on disk + in memory.
  //
  // Mirrors the manager's spec: as soon as the app starts, fire all the
  // slow APIs in parallel:
  //   1. PA providers
  //   2. Baltimore providers
  //   3. For each location's auto-matched provider, that provider's
  //      patient list for today
  //   4. SOAP Notes list (the slow /encounters endpoint)
  //
  // All requests are fire-and-forget; failures are silent because each
  // screen still does its own real fetch with proper error UI. The
  // underlying api.ts already has per-location dedupe so a request that's
  // already in flight from the store-level loadProviders() call won't
  // duplicate.
  // ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    let cancelled = false;

    const today = new Date().toISOString().slice(0, 10);
    const userIdentity = {
      name: user.name ?? null,
      email: user.email ?? null,
    };

    // Helper: for a given location, fetch providers, then auto-match the
    // logged-in clinician, then prefetch their patient list for today.
    // Returns immediately; runs asynchronously in the background.
    const warmLocation = async (location: EclipseLocation) => {
      try {
        const providers = await fetchProviders(location);
        if (cancelled) return;
        const matchedId = findProviderForUser(providers, userIdentity);
        if (!matchedId) return;
        const cached = await getCachedPatients(matchedId, today, location);
        if (cancelled) return;
        if (cached.status === "fresh") return; // already warm
        const list = await fetchPatientsByProviderDate(
          matchedId,
          today,
          "",
          location,
        );
        if (cancelled) return;
        setCachedPatients(matchedId, today, location, list);
      } catch {
        // Best-effort warmup — let the screen-level fetch surface real errors.
      }
    };

    // SOAP Notes warmup. The /encounters endpoint is currently ~4.5 s on
    // prod; warming it at login means the SOAP Notes tab paints instantly
    // when the user first opens it. EncountersScreen also hydrates from
    // the same cache key, so the moment the network response lands here
    // the next tab visit is a free render.
    const warmSamples = async () => {
      try {
        const list = await fetchSamples();
        if (cancelled) return;
        setCachedSamples(list);
      } catch {
        // Silent — the SOAP Notes tab still does its own fetch.
      }
    };

    // Fire all three in parallel. PA + Baltimore + SOAP Notes go out
    // simultaneously; the network and the JS thread are both happy doing
    // this concurrently because each request is just sitting on its own
    // socket waiting for the slow Eclipse / API response.
    void warmLocation("pennsylvania");
    void warmLocation("baltimore");
    void warmSamples();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user]);

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
          // Every tab renders its own brand-green centered heading inside the
          // screen content, so the framework header is hidden globally to
          // avoid duplicate / redundant titles at the top of the screen.
          headerShown: false,
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
          options={{ headerShown: false, tabBarLabel: "SOAP Notes" }}
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
