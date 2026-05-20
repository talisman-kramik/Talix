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
