/**
 * Settings screen — profile, connectivity, privacy, and support.
 */
import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  useWindowDimensions,
  ActivityIndicator,
  Linking,
  Switch,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Card from "../components/Card";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import { useOfflineStore } from "../store/offline";
import { useAuthStore } from "../store/auth";
import { useSettings } from "../store/settings";

// Microsoft Entra ID logout URL
const TENANT_ID = process.env.EXPO_PUBLIC_AZURE_TENANT_ID || "common";
const MS_LOGOUT_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout`;
const APP_SCHEME = "msauth.com.talismansolutions.talixapp";

export default function SettingsScreen() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  // Tab header is hidden for this screen (see App.tsx), so add the system
  // safe-area top inset ourselves to keep the title clear of the status bar.
  const insets = useSafeAreaInsets();
  const { isOnline, checkConnectivity } = useOfflineStore();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const unifiedSyncEnabled = useSettings((s) => s.unifiedSyncEnabled);
  const setUnifiedSyncEnabled = useSettings((s) => s.setUnifiedSyncEnabled);
  const [loggingOut, setLoggingOut] = useState(false);

  const openExternal = async (url: string) => {
    try {
      if (url.startsWith("mailto:")) {
        const canOpen = await Linking.canOpenURL(url);
        if (!canOpen) {
          Alert.alert("Unable to open mail app", "No email app is configured on this device.");
          return;
        }
        await Linking.openURL(url);
        return;
      }
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Alert.alert("Unable to open link", "Please try again.");
    }
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
                `${MS_LOGOUT_URL}?post_logout_redirect_uri=${encodeURIComponent(`${APP_SCHEME}://auth`)}`,
                `${APP_SCHEME}://auth`,
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
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg },
        isTablet && styles.tabletContent,
      ]}
    >
      <Text style={styles.title}>Settings</Text>

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

      <Card>
        <Text style={styles.label}>Connectivity</Text>
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

      <Card>
        <Text style={styles.label}>Data Source</Text>
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextWrap}>
            <Text style={styles.toggleTitle}>Unified data source (canonical feed)</Text>
            <Text style={styles.hint}>
              Read providers and appointments from the canonical server feed.
            </Text>
          </View>
          <Switch
            value={unifiedSyncEnabled}
            onValueChange={setUnifiedSyncEnabled}
            trackColor={{ false: colors.border, true: colors.brand }}
          />
        </View>
      </Card>

      <Card>
        <Text style={styles.label}>Help</Text>
        <Text style={styles.hint}>Need assistance with Talix? Use one of the options below.</Text>
        <TouchableOpacity style={styles.linkRow} onPress={() => openExternal("mailto:info@talismansolutions.com")}>
          <View style={styles.linkRowLeft}>
            <Ionicons name="mail-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.linkRowText}>Contact Support</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.linkRow} onPress={() => openExternal("https://talismansolutions.com")}>
          <View style={styles.linkRowLeft}>
            <Ionicons name="globe-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.linkRowText}>Visit Website</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </TouchableOpacity>
      </Card>

      <Card>
        <Text style={styles.label}>Privacy</Text>
        <View style={styles.privacyBulletRow}>
          <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.privacyText}>Audio and notes stay on your configured infrastructure.</Text>
        </View>
        <View style={styles.privacyBulletRow}>
          <Ionicons name="shield-checkmark-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.privacyText}>Talix is built for HIPAA-compliant workflows.</Text>
        </View>
        <TouchableOpacity style={styles.linkRow} onPress={() => openExternal("https://talismansolutions.com/privacy-policy/")}>
          <View style={styles.linkRowLeft}>
            <Ionicons name="document-text-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.linkRowText}>Privacy Policy</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </TouchableOpacity>
      </Card>

      <Card>
        <Text style={styles.label}>About</Text>
        <Text style={styles.hint}>Talix v1.0.0</Text>
        <Text style={styles.hint}>A Talisman Solutions product</Text>
        <Text style={[styles.hint, { marginTop: spacing.sm }]}>
          An AI-powered iOS medical documentation platform for generating structured SOAP notes with secure and HIPAA-compliant clinical workflows.
        </Text>
      </Card>

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
  title: {
    fontSize: fontSize.xxl,
    fontWeight: "700",
    color: colors.brand,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  label: { fontSize: fontSize.sm, fontWeight: "600", color: colors.text },
  hint: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
    backgroundColor: "#E6F9F1",
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
  statusText: { fontSize: fontSize.sm, fontWeight: "600", marginLeft: spacing.sm },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  toggleTextWrap: { flex: 1 },
  toggleTitle: { fontSize: fontSize.sm, color: colors.text, fontWeight: "500" },
  linkRow: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  linkRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  linkRowText: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "500",
  },
  privacyBulletRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  privacyText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    flex: 1,
  },
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
