import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  AppState,
  AppStateStatus,
} from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { Ionicons } from "@expo/vector-icons";
import { colors, fontSize, spacing } from "../lib/theme";

interface Props {
  userName?: string;
  onUnlock: () => void;
}

/**
 * Biometric Lock Screen — shown when the app requires Face ID / Touch ID
 * to access. This is a SECURITY gate, not a login method.
 * The user is already authenticated via Microsoft; this just prevents
 * unauthorized physical access to the device.
 */
export default function BiometricLockScreen({ userName, onUnlock }: Props) {
  const [error, setError] = useState<string | null>(null);

  // Prompt biometric automatically when this screen mounts
  useEffect(() => {
    authenticate();
  }, []);

  const authenticate = async () => {
    try {
      setError(null);
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Talix",
        fallbackLabel: "Use Passcode",
        disableDeviceFallback: false,
      });

      if (result.success) {
        onUnlock();
      } else {
        setError("Authentication failed. Tap to try again.");
      }
    } catch (e) {
      console.error("Biometric error:", e);
      setError("An error occurred. Tap to try again.");
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Ionicons name="lock-closed" size={40} color={colors.brand} />
        </View>

        <Text style={styles.title}>Talix is Locked</Text>

        {userName ? (
          <Text style={styles.subtitle}>Signed in as {userName}</Text>
        ) : null}

        <Text style={styles.hint}>
          Use Face ID or your device passcode to unlock
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity style={styles.unlockButton} onPress={authenticate}>
          <Ionicons name="finger-print" size={24} color="#fff" />
          <Text style={styles.unlockText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  content: {
    alignItems: "center",
    gap: spacing.md,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.brandLight || "#E6F9F1",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
  },
  hint: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    textAlign: "center",
    lineHeight: 20,
  },
  error: {
    fontSize: fontSize.sm,
    color: colors.error,
    textAlign: "center",
  },
  unlockButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brand,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: 12,
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  unlockText: {
    color: "#fff",
    fontSize: fontSize.md,
    fontWeight: "600",
  },
});
