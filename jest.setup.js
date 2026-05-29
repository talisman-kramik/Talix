// Jest setup for React Native mobile app tests

// Mock fetch globally
global.fetch = jest.fn();

// Mock expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: { hostUri: '192.168.1.42:8081' },
}));

// Mock @react-native-async-storage/async-storage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

// Mock react-native-markdown-display
jest.mock('react-native-markdown-display', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }) => React.createElement(Text, null, children),
  };
});

// Mock @expo/vector-icons
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Ionicons: (props) => React.createElement(View, { testID: 'mock-icon' }),
  };
});

// Mock expo-av — the native ExponentAV module is unavailable in the jest env.
// Tests only need the surface area used by `useAmendVoiceRecorder`.
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
    setAudioModeAsync: jest.fn(() => Promise.resolve()),
    Recording: {
      createAsync: jest.fn(() =>
        Promise.resolve({
          recording: {
            stopAndUnloadAsync: jest.fn(() => Promise.resolve()),
            getURI: jest.fn(() => 'file:///mock/recording.m4a'),
          },
        }),
      ),
    },
    Sound: {
      createAsync: jest.fn(() =>
        Promise.resolve({
          sound: {
            unloadAsync: jest.fn(() => Promise.resolve()),
            playAsync: jest.fn(() => Promise.resolve()),
            pauseAsync: jest.fn(() => Promise.resolve()),
            setPositionAsync: jest.fn(() => Promise.resolve()),
            getStatusAsync: jest.fn(() =>
              Promise.resolve({ isLoaded: true, isPlaying: false, positionMillis: 0, durationMillis: 0 }),
            ),
          },
        }),
      ),
    },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
  },
}));
