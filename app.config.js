/**
 * Expo dynamic config — merges app.json and injects optional default API URL.
 * Set EXPO_PUBLIC_AI_SCRIBE_API_URL in client/mobile/.env (see .env.example).
 */
const appJson = require("./app.json");

module.exports = {
  expo: {
    ...appJson.expo,
    plugins: [...(appJson.expo.plugins || []), "@react-native-community/datetimepicker"],
    extra: {
      ...(appJson.expo.extra || {}),
      apiUrl: process.env.EXPO_PUBLIC_AI_SCRIBE_API_URL?.trim() || undefined,
    },
  },
};
