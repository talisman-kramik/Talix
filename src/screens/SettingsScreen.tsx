/**
 * Settings screen — Profile, API URL configuration + offline queue management.
 */
import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  useWindowDimensions,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

import Card from "../components/Card";
import Badge from "../components/Badge";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import { useSettings, DEFAULT_API_URL } from "../store/settings";
import { useOfflineStore } from "../store/offline";
import { useAuthStore } from "../store/auth";

// Microsoft Entra ID logout URL
const TENANT_ID = process.env.EXPO_PUBLIC_AZURE_TENANT_ID || "common";
const MS_LOGOUT_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout`;
const APP_SCHEME = "msauth.com.talismansolutions.talixapp";

export default function SettingsScreen() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const { apiUrl, setApiUrl, configured } = useSettings();
  const { queue, remove, processQueue, isOnline, checkConnectivity } = useOfflineStore();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [urlDraft, setUrlDraft] = useState(apiUrl);
  const [testing, setTesting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const saveUrl = () => {
    const trimmed = urlDraft.trim().replace(/\/+$/, "");
    if (!trimmed) {
      Alert.alert("Invalid URL", "API URL cannot be empty.");
      return;
    }
    setApiUrl(trimmed);
    setTestResult(null);
    Alert.alert("Saved", `API URL set to: ${trimmed}`);
  };

  const testConnection = async () => {
    const trimmed = urlDraft.trim().replace(/\/+$/, "");
    if (!trimmed) {
      setTestResult({ ok: false, msg: "URL cannot be empty" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${trimmed}/providers`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        setTestResult({ ok: true, msg: "Connected to provider-facing server" });
      } else {
        setTestResult({ ok: false, msg: `Server responded with ${res.status}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed";
      setTestResult({ ok: false, msg: msg.includes("abort") ? "Connection timed out (5s)" : msg });
    }
    setTesting(false);
  };

  const resetToDefault = () => {
    setUrlDraft(DEFAULT_API_URL);
    setTestResult(null);
  };

  const retryQueue = async () => {
    await checkConnectivity();
    await processQueue();
  };

  const handleLogout = () => {
    Alert.alert(
      "Log Out",
      "Are you sure you want to log out?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log Out",
          style: "destructive",
          onPress: async () => {
            setLoggingOut(true);
            try {
              // Clear the Microsoft browser session so next login shows account picker
              await WebBrowser.openAuthSessionAsync(
                `${MS_LOGOUT_URL}?post_logout_redirect_uri=${encodeURIComponent("msauth.com.talismansolutions.talix://auth")}`,
                "msauth.com.talismansolutions.talix://auth",
              );
            } catch (e) {
              // If browser logout fails, still proceed with local logout
              console.warn("Microsoft session logout skipped:", e);
            }
            await logout();
            setLoggingOut(false);
          },
        },
      ],
    );
  };

  // Get user initials for the avatar
  const getInitials = (name?: string) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, isTablet && styles.tabletContent]}
    >
      <Text style={styles.title}>Settings</Text>

      {/* ── Profile Card ────────────────────────────────────────────── */}
      <Card>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{getInitials(user?.name)}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{user?.name || "Provider"}</Text>
            {user?.email ? (
              <Text style={styles.profileEmail}>{user.email}</Text>
            ) : null}
            <View style={styles.methodBadge}>
              <Ionicons
                name={user?.method === "entra" ? "shield-checkmark" : "finger-print"}
                size={12}
                color={colors.brand}
              />
              <Text style={styles.methodText}>
                {user?.method === "entra" ? "Microsoft SSO" : "Biometric"}
              </Text>
            </View>
          </View>
        </View>
      </Card>

      {/* First-launch banner */}
      {!configured && (
        <Card style={{ backgroundColor: "#DBEAFE", borderColor: "#3B82F6" }}>
          <View style={styles.row}>
            <Ionicons name="information-circle" size={18} color="#1D4ED8" />
            <Text style={{ color: "#1D4ED8", fontSize: fontSize.sm, marginLeft: spacing.sm, flex: 1 }}>
              Configure the provider-facing server URL below, then tap "Test Connection" to verify.
            </Text>
          </View>
        </Card>
      )}

      {/* API URL */}
      <Card>
        <Text style={styles.label}>Provider Server URL</Text>
        <Text style={styles.hint}>
          FastAPI base URL (provider :8000 or pipeline :8100). Must be reachable from this device — use a LAN IP or HTTPS host, not localhost on a physical phone.
        </Text>
        <TextInput
          value={urlDraft}
          onChangeText={(t) => { setUrlDraft(t); setTestResult(null); }}
          style={styles.input}
          placeholder="http://192.168.1.100:8000 or http://host:8100"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        {/* Auto-detected default hint */}
        {!configured && DEFAULT_API_URL !== "http://localhost:8000" && (
          <Text style={[styles.hint, { color: colors.brand }]}>
            Auto-detected: {DEFAULT_API_URL}
          </Text>
        )}

        {/* Test result */}
        {testResult && (
          <View style={[styles.row, { marginTop: spacing.sm }]}>
            <Ionicons
              name={testResult.ok ? "checkmark-circle" : "close-circle"}
              size={16}
              color={testResult.ok ? colors.success : colors.error}
            />
            <Text style={{
              fontSize: fontSize.xs,
              color: testResult.ok ? colors.success : colors.error,
              marginLeft: spacing.xs,
              flex: 1,
            }}>
              {testResult.msg}
            </Text>
          </View>
        )}

        <View style={[styles.row, { marginTop: spacing.md, gap: spacing.sm }]}>
          <TouchableOpacity style={styles.testBtn} onPress={testConnection} disabled={testing}>
            {testing ? (
              <ActivityIndicator size="small" color={colors.indigo} />
            ) : (
              <Ionicons name="pulse" size={14} color={colors.indigo} />
            )}
            <Text style={styles.testBtnText}>Test Connection</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.saveBtn} onPress={saveUrl}>
            <Text style={styles.saveBtnText}>Save</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={resetToDefault} style={{ marginLeft: "auto" }}>
            <Text style={{ fontSize: fontSize.xs, color: colors.textTertiary }}>Reset to Default</Text>
          </TouchableOpacity>
        </View>
      </Card>

      {/* Connection status */}
      <Card>
        <View style={styles.row}>
          <Ionicons
            name={isOnline ? "cloud-done" : "cloud-offline"}
            size={20}
            color={isOnline ? colors.brand : colors.warning}
          />
          <Text style={[styles.statusText, { color: isOnline ? colors.brand : colors.warning }]}>
            {isOnline ? "Connected" : "Offline"}
          </Text>
          <TouchableOpacity onPress={checkConnectivity} style={{ marginLeft: "auto" }}>
            <Ionicons name="refresh" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </Card>

      {/* Offline queue */}
      <Card>
        <View style={styles.row}>
          <Text style={styles.label}>Offline Queue</Text>
          <Badge label={`${queue.length}`} variant={queue.length > 0 ? "warning" : "neutral"} />
        </View>

        {queue.length === 0 ? (
          <Text style={styles.hint}>No queued recordings.</Text>
        ) : (
          <>
            {queue.map((item) => (
              <View key={item.id} style={styles.queueItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.queueTitle}>{item.provider_id}</Text>
                  <Text style={styles.queueMeta}>
                    {item.mode} · {item.visit_type} · {new Date(item.createdAt).toLocaleString()}
                  </Text>
                  {item.error && <Text style={styles.queueError}>{item.error}</Text>}
                </View>
                <Badge
                  label={item.status}
                  variant={item.status === "failed" ? "error" : item.status === "uploading" ? "info" : "neutral"}
                />
                <TouchableOpacity onPress={() => remove(item.id)} style={{ marginLeft: spacing.sm }}>
                  <Ionicons name="trash-outline" size={18} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.retryBtn} onPress={retryQueue}>
              <Ionicons name="cloud-upload" size={16} color={colors.textInverse} />
              <Text style={styles.retryBtnText}>Retry All</Text>
            </TouchableOpacity>
          </>
        )}
      </Card>

      {/* About */}
      <Card>
        <Text style={styles.label}>About</Text>
        <Text style={styles.hint}>Talix v1.0.0</Text>
        <Text style={styles.hint}>Talisman Solutions</Text>
        <Text style={[styles.hint, { marginTop: spacing.sm }]}>
          HIPAA-compliant medical documentation. All audio is processed on your own servers — zero PHI egress.
        </Text>
      </Card>

      {/* Account — Log Out */}
      <Card style={{ marginTop: spacing.md, marginBottom: spacing.xl }}>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} disabled={loggingOut}>
          {loggingOut ? (
            <ActivityIndicator size="small" color={colors.error} />
          ) : (
            <Ionicons name="log-out-outline" size={20} color={colors.error} />
          )}
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </Card>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  tabletContent: { maxWidth: 640, alignSelf: "center", width: "100%" },
  title: { fontSize: fontSize.xxl, fontWeight: "700", color: colors.text },
  label: { fontSize: fontSize.sm, fontWeight: "600", color: colors.text },
  hint: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.text,
    marginTop: spacing.md,
  },
  // ── Profile styles ──────────────────────────────────────────────────
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: fontSize.lg,
    fontWeight: "700",
    color: colors.text,
  },
  profileEmail: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  methodBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.xs,
    backgroundColor: colors.brandLight || "#E6F9F1",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 12,
    alignSelf: "flex-start",
  },
  methodText: {
    fontSize: fontSize.xs,
    color: colors.brand,
    fontWeight: "600",
  },
  // ── Buttons ─────────────────────────────────────────────────────────
  saveBtn: {
    backgroundColor: colors.brand,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
  },
  saveBtnText: { color: colors.textInverse, fontWeight: "600", fontSize: fontSize.sm },
  testBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.indigo,
  },
  testBtnText: { color: colors.indigo, fontWeight: "600", fontSize: fontSize.sm },
  statusText: { fontSize: fontSize.sm, fontWeight: "600", marginLeft: spacing.sm },
  queueItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  queueTitle: { fontSize: fontSize.sm, fontWeight: "600", color: colors.text },
  queueMeta: { fontSize: fontSize.xs, color: colors.textSecondary },
  queueError: { fontSize: fontSize.xs, color: colors.error, marginTop: 2 },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brand,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  retryBtnText: { color: colors.textInverse, fontWeight: "600", fontSize: fontSize.sm },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  logoutText: {
    color: colors.error,
    fontWeight: "600",
    fontSize: fontSize.md,
  },
});
