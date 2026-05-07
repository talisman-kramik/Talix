# Talix

Talix is a React Native mobile application tailored for providers and patients, designed to interface with the Eclipse (InsightOut) API and the MDCO AI Scribe backend. It provides secure access to multi-location data, encounters, and patient records.

## Features

- **Secure Authentication**: Microsoft Entra ID (SSO) login flow.
- **App Review Demo Access**: Dedicated username/password login path for Apple App Review without Microsoft SSO.
- **Biometric Security**: Persistent biometric lock (Face ID / Touch ID) ensuring secure session management.
- **Encounters Management**: View and manage patient encounters seamlessly.
- **Provider Data**: Multi-location data sourcing for providers.

## Tech Stack

- **Framework**: React Native (Expo)
- **Language**: TypeScript
- **Authentication**: Microsoft Entra OAuth2, iOS/Android Native Biometrics

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm or yarn
- Expo CLI
- iOS Simulator or Android Emulator (or a physical device with Expo Go)

### Installation

1. **Clone the repository:**
   ```bash
   git clone git@github.com-talisman:talisman-kramik/Talix.git
   cd Talix
   ```

2. **Install dependencies:**
   ```bash
   npm install
   # or
   yarn install
   ```

3. **Environment Setup:**
   - Copy `.env.example` to `.env`.
   - Update the variables with your Microsoft Entra credentials and Eclipse API endpoints.
   ```bash
   cp .env.example .env
   ```

4. **Run the App:**
   ```bash
   npx expo start
   npx expo run:ios --device --configuration Release
   ```
   Use the Expo app on your phone to scan the QR code, or press `i` to open in the iOS simulator, or `a` for the Android emulator.

## Release to TestFlight

Run from the `Talix` folder:

```bash
git push -u origin main
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

Optional one-line non-interactive command:

```bash
git push -u origin main && eas build --platform ios --profile production --non-interactive && eas submit --platform ios --profile production --latest --non-interactive
```
