import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as AuthSession from "expo-auth-session";
import { Ionicons } from "@expo/vector-icons";
import { colors, fontSize, spacing } from "../lib/theme";
import { useAuthStore } from "../store/auth";

WebBrowser.maybeCompleteAuthSession();

// ── Organization Configurations ───────────────────────────────────────
const ORGANIZATIONS = [
  {
    id: "talisman",
    name: "Talisman Solutions",
    clientId: process.env.EXPO_PUBLIC_AZURE_CLIENT_ID || "",
    tenantId: process.env.EXPO_PUBLIC_AZURE_TENANT_ID || "",
  },
  {
    id: "excelsiainjury",
    name: "Excelsiainjurycare",
    clientId: process.env.EXPO_PUBLIC_EXCELSIAINJURY_CLIENT_ID || "",
    tenantId: process.env.EXPO_PUBLIC_EXCELSIAINJURY_TENANT_ID || "",
  },
];

const SCOPES = ["openid", "profile", "email", "User.Read"];

const redirectUri = AuthSession.makeRedirectUri({
  scheme: "msauth.com.talismansolutions.talixapp",
  path: "auth",
});

export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);

  // Which org is selected — null means no org picked yet
  const [selectedOrg, setSelectedOrg] = useState<typeof ORGANIZATIONS[0] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Discovery document computed from selected org's tenant
  const discovery: AuthSession.DiscoveryDocument | null = selectedOrg
    ? {
        authorizationEndpoint: `https://login.microsoftonline.com/${selectedOrg.tenantId}/oauth2/v2.0/authorize`,
        tokenEndpoint: `https://login.microsoftonline.com/${selectedOrg.tenantId}/oauth2/v2.0/token`,
      }
    : null;

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    selectedOrg
      ? {
          clientId: selectedOrg.clientId,
          scopes: SCOPES,
          redirectUri,
          responseType: AuthSession.ResponseType.Code,
          usePKCE: true,
          prompt: AuthSession.Prompt.SelectAccount as any,
          extraParams: { prompt: "select_account" },
        }
      : { clientId: "", scopes: [], redirectUri },
    discovery,
  );

  // ── Handle Microsoft response ─────────────────────────────────────────
  useEffect(() => {
    if (response?.type === "success") {
      const { code } = response.params;
      exchangeCodeForToken(code);
    } else if (response?.type === "error") {
      Alert.alert(
        "Authentication Error",
        response.error?.message || "Failed to log in with Microsoft.",
      );
      setSelectedOrg(null);
    }
  }, [response]);

  // ── Exchange code → token → profile ──────────────────────────────────
  const exchangeCodeForToken = async (code: string) => {
    if (!selectedOrg) return;
    try {
      setIsLoading(true);
      const discovery = {
        tokenEndpoint: `https://login.microsoftonline.com/${selectedOrg.tenantId}/oauth2/v2.0/token`,
      };
      const tokenResponse = await AuthSession.exchangeCodeAsync(
        {
          clientId: selectedOrg.clientId,
          code,
          redirectUri,
          extraParams: { code_verifier: request?.codeVerifier || "" },
        },
        discovery,
      );

      const accessToken = tokenResponse.accessToken;
      const userInfo = await fetchMicrosoftProfile(accessToken);

      await login(
        {
          method: "entra",
          name: userInfo.displayName || userInfo.givenName || "User",
          email: userInfo.mail || userInfo.userPrincipalName || "",
          microsoftId: userInfo.id,
          organization: selectedOrg.name,
        },
        accessToken,
      );
    } catch (error: any) {
      console.error("Token exchange error:", error);
      Alert.alert("Login Failed", error?.message || "Could not complete sign-in. Please try again.");
      setSelectedOrg(null);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchMicrosoftProfile = async (accessToken: string) => {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Microsoft Graph /me failed: ${res.status}`);
    return res.json();
  };

  // ── Demo login for App Review (Apple reviewer access) ────────────────
  const onDemoLogin = async () => {
    await login({
      method: "entra",
      name: "Demo Reviewer",
      email: "demo@talismansolutions.com",
      microsoftId: "demo-reviewer",
      organization: "Talisman Solutions",
    });
  };

  // ── When org is selected, launch Microsoft login ──────────────────────
  const onOrgSelect = async (org: typeof ORGANIZATIONS[0]) => {
    if (!org.clientId) {
      Alert.alert("Configuration Missing", `Client ID for ${org.name} is not configured.`);
      return;
    }
    setSelectedOrg(org);
  };

  // Trigger promptAsync after selectedOrg + request is ready
  useEffect(() => {
    if (selectedOrg && request) {
      promptAsync().catch((e) => {
        console.error("promptAsync error:", e);
        setSelectedOrg(null);
      });
    }
  }, [request]);

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="medical" size={48} color={colors.brand} />
        <Text style={styles.title}>Talix</Text>
        <Text style={styles.subtitle}>Medical Clinical Documentation</Text>
      </View>

      <Text style={styles.sectionLabel}>Select your organization</Text>

      <View style={styles.orgsContainer}>
        {ORGANIZATIONS.map((org) => (
          <TouchableOpacity
            key={org.id}
            style={[
              styles.orgButton,
              selectedOrg?.id === org.id && styles.orgButtonActive,
            ]}
            onPress={() => onOrgSelect(org)}
            disabled={isLoading}
          >
            {isLoading && selectedOrg?.id === org.id ? (
              <ActivityIndicator color={colors.brand} />
            ) : (
              <View style={styles.orgRow}>
                <View style={styles.orgIconWrap}>
                  <Ionicons name="business" size={20} color={colors.brand} />
                </View>
                <View style={styles.orgInfo}>
                  <Text style={styles.orgName}>{org.name}</Text>
                  <Text style={styles.orgHint}>Sign in with Microsoft</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.footerText}>
        Sign in with your organization's Microsoft account to get started.
      </Text>

      <TouchableOpacity onPress={onDemoLogin} style={styles.demoBtn} disabled={isLoading}>
        <Text style={styles.demoBtnText}>App Review / Demo Access</Text>
      </TouchableOpacity>

      {__DEV__ && (
        <Text style={styles.debugText}>Redirect URI: {redirectUri}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.xl,
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  header: {
    alignItems: "center",
    marginBottom: spacing.xxl,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: colors.text,
    marginTop: spacing.md,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  sectionLabel: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  orgsContainer: {
    gap: spacing.md,
  },
  orgButton: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.md,
  },
  orgButtonActive: {
    borderColor: colors.brand,
    backgroundColor: "#E6F9F1",
  },
  orgRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  orgIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#E6F9F1",
    alignItems: "center",
    justifyContent: "center",
  },
  orgInfo: {
    flex: 1,
  },
  orgName: {
    fontSize: fontSize.md,
    fontWeight: "700",
    color: colors.text,
  },
  orgHint: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 2,
  },
  footerText: {
    textAlign: "center",
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    marginTop: spacing.xl,
    lineHeight: 20,
  },
  demoBtn: {
    marginTop: spacing.xl,
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  demoBtnText: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    textDecorationLine: "underline",
  },
  debugText: {
    textAlign: "center",
    color: colors.textTertiary,
    fontSize: 10,
    marginTop: spacing.md,
    fontFamily: "Courier",
  },
});
