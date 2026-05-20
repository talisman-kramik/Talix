# Mobile-Web Sync — Mobile App Implementation

> **Status:** Implemented (May 2026)
> **Location:** `mobile app/src/`

---

## Overview

The mobile app (React Native / Expo) implements two features for Mobile-Web Sync:

1. **Web-Status Banner** — Shows a non-dismissible banner on the encounter detail screen when the encounter has been edited on the web
2. **Full Demographics on Upload** — Includes all required demographics in the upload payload so the web history page and SFTP workflow have the data they need

---

## Web-Status Banner

### Files

| File | Purpose |
|------|---------|
| `src/lib/api.ts` | `fetchWebStatus(id)` — fetches web-status with 5s timeout |
| `src/components/WebStatusBanner.tsx` | Banner component + `shouldShowBanner()` helper |
| `src/screens/EncounterDetailScreen.tsx` | Integrates fetch + banner display |

### Behavior

1. **On screen focus** (mount, foreground return, navigation back): fires non-blocking `fetchWebStatus(sampleId)`
2. **Non-blocking:** Encounter content renders immediately; banner appears when response arrives
3. **Banner shown** for statuses: `"Provider Edited"`, `"Provider Reviewed"`, `"MT Reviewed"`
4. **No banner** on 404 (null response) or any error (silent suppression)
5. **Re-fetch** on every `useFocusEffect` trigger

### API Function

```typescript
export async function fetchWebStatus(id: string): Promise<WebStatus | null> {
  // GET /encounters/{id}/web-status with 5s AbortController timeout
  // Returns null on 404, throws on error
}
```

### Banner Component

```tsx
<WebStatusBanner webStatus={webStatus} />
```

- Non-dismissible (no close button)
- Amber warning style
- Text: "This encounter has been modified on the web. Please refer to the web app for the latest version."

---

## Full Demographics on Upload

### Files

| File | Purpose |
|------|---------|
| `src/lib/api.ts` | `EncounterDemographics` interface, `buildEncounterDetails()`, `validateProviderName()` |
| `src/screens/RecordScreen.tsx` | Builds demographics from selected provider/patient, validates before upload |

### Interface

```typescript
export interface EncounterDemographics {
  provider_name: string;      // Required: at least 1 non-whitespace char
  patient_name: string;
  patient_dob: string;        // ISO 8601 date: YYYY-MM-DD
  account_number: string;
  case_name: string;
  location_name: string;
  system_location: string;
}
```

### Helper Functions

```typescript
// Validates provider_name has at least 1 non-whitespace character
export function validateProviderName(providerName: string): boolean;

// Builds demographics payload with defaults for missing optional fields
export function buildEncounterDetails(params: {
  providerName: string;
  patientName: string;
  patientDob: string;
  accountNumber?: string;
  caseName?: string;
  locationName?: string;
  systemLocation?: string;
}): EncounterDemographics;
```

### Upload Flow

1. User selects provider + patient + records audio
2. On submit: `validateProviderName()` — shows Alert if invalid
3. Builds demographics via `buildEncounterDetails()`
4. Calls `uploadEncounterAudio(encounterId, audioUri, filename, noteAudioUri, noteFilename, demographics)`
5. Demographics sent as `encounter_details` form field (JSON string) in the multipart upload
6. Pipeline_Server stores demographics in `encounter_details.json`

### Offline Queue

The offline queue (`src/store/offline.ts`) stores demographics alongside queued encounters so they're included when the queue is processed on reconnection.

---

## Testing

### Test Files

| File | Tests |
|------|-------|
| `src/screens/__tests__/EncounterDetailScreen.test.tsx` | Banner display, no banner on 404/error, non-blocking fetch, re-fetch on focus (15 tests) |
| `src/lib/__tests__/demographics.test.ts` | Demographics payload construction, provider_name validation (8 tests) |

### Running Tests

```bash
cd "mobile app"
npm test
```

### Test Coverage

**Banner tests:**
- Banner displays for "Provider Edited", "Provider Reviewed", "MT Reviewed"
- No banner when fetchWebStatus returns null (404)
- No banner on network error or timeout
- Encounter content renders before web-status response arrives
- Web-status re-fetched on screen focus return
- `shouldShowBanner()` logic for all status values

**Demographics tests:**
- `buildEncounterDetails` includes all 7 required fields
- `patient_dob` passed through as-is
- Missing optional fields default to empty string
- `validateProviderName` returns true for non-empty strings
- `validateProviderName` returns false for empty/whitespace-only
- `uploadEncounterAudio` throws if demographics has invalid provider_name

---

## Configuration

The mobile app connects to the Pipeline_Server directly for web-status reads. The API base URL is configured via:

```bash
EXPO_PUBLIC_AI_SCRIBE_API_URL=http://your-pipeline-server:8100
```

The `AI_SCRIBE_API_KEY` is included in requests via the `getAuthHeaders()` helper.
