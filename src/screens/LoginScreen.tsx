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

// ── Microsoft Entra ID Configuration ──────────────────────────────────
const TENANT_ID = process.env.EXPO_PUBLIC_AZURE_TENANT_ID || "common";
const CLIENT_ID = process.env.EXPO_PUBLIC_AZURE_CLIENT_ID || "";
const SCOPES = ["openid", "profile", "email", "User.Read"];

// Microsoft v2.0 OAuth endpoints for this tenant
const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
  tokenEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
};

// ── Redirect URI ──────────────────────────────────────────────────────
const redirectUri = AuthSession.makeRedirectUri({
  scheme: "msauth.com.talismansolutions.talix",
  path: "auth",
});

export default function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const [isLoading, setIsLoading] = useState(false);

  // ── Auth Request (PKCE) ─────────────────────────────────────────────
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: CLIENT_ID,
      scopes: SCOPES,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      prompt: AuthSession.Prompt.SelectAccount as any,
      extraParams: {
        prompt: "select_account",
      },
    },
    discovery,
  );

  // ── Handle the response from the Microsoft login page ───────────────
  useEffect(() => {
    if (response?.type === "success") {
      const { code } = response.params;
      exchangeCodeForToken(code);
    } else if (response?.type === "error") {
      Alert.alert(
        "Authentication Error",
        response.error?.message || "Failed to log in with Microsoft.",
      );
    }
  }, [response]);

  // ── Exchange auth code → access token → fetch profile ───────────────
  const exchangeCodeForToken = async (code: string) => {
    try {
      setIsLoading(true);

      const tokenResponse = await AuthSession.exchangeCodeAsync(
        {
          clientId: CLIENT_ID,
          code,
          redirectUri,
          extraParams: {
            code_verifier: request?.codeVerifier || "",
          },
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
        },
        accessToken,
      );
    } catch (error: any) {
      console.error("Token exchange error:", error);
      Alert.alert(
        "Login Failed",
        error?.message || "Could not complete the sign-in. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  // ── Microsoft Graph: GET /me ────────────────────────────────────────
  const fetchMicrosoftProfile = async (accessToken: string) => {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Microsoft Graph /me failed with status ${res.status}`);
    }
    return res.json();
  };

  // ── Microsoft SSO button press ──────────────────────────────────────
  const onMicrosoftLogin = async () => {
    if (!CLIENT_ID) {
      Alert.alert(
        "Configuration Missing",
        "Microsoft Client ID is not set. Please add EXPO_PUBLIC_AZURE_CLIENT_ID to your .env file.",
      );
      return;
    }
    setIsLoading(true);
    try {
      await promptAsync();
    } catch (error) {
      console.error("Microsoft login error:", error);
      Alert.alert("Error", "Failed to start Microsoft Login.");
    } finally {
      setIsLoading(false);
    }
  };

  // ── UI ──────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="medical" size={48} color={colors.brand} />
        <Text style={styles.title}>Talix</Text>
        <Text style={styles.subtitle}>Medical Clinical Documentation</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={onMicrosoftLogin}
          disabled={!request || isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="logo-microsoft" size={20} color="#fff" style={styles.buttonIcon} />
              <Text style={styles.primaryButtonText}>Sign in with Microsoft</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <Text style={styles.footerText}>
        Sign in with your organization's Microsoft account to get started.
      </Text>

      {/* Debug info — remove in production */}
      {__DEV__ && (
        <Text style={styles.debugText}>
          Redirect URI: {redirectUri}
        </Text>
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
  actions: {
    gap: spacing.md,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.md,
    borderRadius: 12,
  },
  primaryButton: {
    backgroundColor: colors.brand,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: fontSize.md,
    fontWeight: "600",
  },
  buttonIcon: {
    marginRight: spacing.sm,
  },
  footerText: {
    textAlign: "center",
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    marginTop: spacing.xl,
    lineHeight: 20,
  },
  debugText: {
    textAlign: "center",
    color: colors.textTertiary,
    fontSize: 10,
    marginTop: spacing.md,
    fontFamily: "Courier",
  },
});
