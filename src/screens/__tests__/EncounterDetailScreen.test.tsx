/**
 * Unit tests for EncounterDetailScreen — Web-Status Banner
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
 *
 * Tests:
 * - Banner display for each valid status value ("Provider Edited", "Provider Reviewed", "MT Reviewed")
 * - No banner on 404 (fetchWebStatus returns null)
 * - No banner on network error/timeout
 * - Non-blocking fetch: encounter content renders before web-status response arrives
 * - Re-fetch on screen focus return
 */
import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { shouldShowBanner } from '../../components/WebStatusBanner';
import type { WebStatus } from '../../lib/api';

// --- Mocks ---

// Store the latest useFocusEffect callback for manual re-triggering
const mockUseFocusEffect = jest.fn();

jest.mock('@react-navigation/native', () => {
  const { useEffect } = require('react');
  return {
    useFocusEffect: (callback: any) => {
      mockUseFocusEffect(callback);
      // Simulate useFocusEffect by delegating to useEffect with empty deps
      // This runs the callback once after mount (like initial focus)
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => {
        const cleanup = callback();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
    },
  };
});

// Mock the API module
const mockFetchSample = jest.fn();
const mockFetchNote = jest.fn();
const mockFetchWebStatus = jest.fn();

jest.mock('../../lib/api', () => ({
  fetchSample: (...args: any[]) => mockFetchSample(...args),
  fetchNote: (...args: any[]) => mockFetchNote(...args),
  fetchWebStatus: (...args: any[]) => mockFetchWebStatus(...args),
}));

// Mock the settings store
jest.mock('../../store/settings', () => ({
  getApiUrl: () => 'http://localhost:8000',
  getApiKey: () => 'test-key',
}));

// Mock the date utility
jest.mock('../../lib/date', () => ({
  formatDateUS: (d: string) => d,
}));

import EncounterDetailScreen from '../EncounterDetailScreen';

// --- Helpers ---

const baseSample = {
  sample_id: 'test-encounter-123',
  mode: 'dictation' as const,
  physician: 'Dr. Smith',
  versions: ['v1'],
  latest_version: 'v1',
  has_gold: false,
  quality: {
    overall: 4.5,
    accuracy: null,
    completeness: null,
    no_hallucination: null,
    structure: null,
    language: null,
    overlap: null,
  },
  patient_context: null,
};

const defaultRoute = {
  params: { sampleId: 'test-encounter-123' },
};

function setupDefaultMocks() {
  mockFetchSample.mockResolvedValue(baseSample);
  mockFetchNote.mockResolvedValue({ content: '# Clinical Note\nSample content' });
}

function renderScreen(routeOverride?: any) {
  return render(
    <EncounterDetailScreen route={routeOverride ?? defaultRoute} />
  );
}

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaultMocks();
});

describe('EncounterDetailScreen — Web-Status Banner', () => {
  describe('Banner display for valid status values', () => {
    it('displays banner for "Provider Edited" status', async () => {
      mockFetchWebStatus.mockResolvedValue({
        status: 'Provider Edited',
        edited_at: '2025-01-15T10:30:00Z',
        edited_by: 'Dr. Smith',
        soap_version: 3,
      });

      const { findByText } = renderScreen();

      // Wait for the banner text to appear
      const bannerText = await findByText(/modified on the web/i);
      expect(bannerText).toBeTruthy();
      expect(mockFetchWebStatus).toHaveBeenCalledWith('test-encounter-123');
    });

    it('displays banner for "Provider Reviewed" status', async () => {
      mockFetchWebStatus.mockResolvedValue({
        status: 'Provider Reviewed',
        edited_at: '2025-01-15T11:00:00Z',
        edited_by: 'Dr. Jones',
        soap_version: 2,
      });

      const { findByText } = renderScreen();

      const bannerText = await findByText(/modified on the web/i);
      expect(bannerText).toBeTruthy();
      expect(mockFetchWebStatus).toHaveBeenCalledWith('test-encounter-123');
    });

    it('displays banner for "MT Reviewed" status', async () => {
      mockFetchWebStatus.mockResolvedValue({
        status: 'MT Reviewed',
        edited_at: '2025-01-15T12:00:00Z',
        edited_by: 'MT Team',
        soap_version: 1,
      });

      const { findByText } = renderScreen();

      const bannerText = await findByText(/modified on the web/i);
      expect(bannerText).toBeTruthy();
      expect(mockFetchWebStatus).toHaveBeenCalledWith('test-encounter-123');
    });
  });

  describe('No banner on 404 or error', () => {
    it('shows no banner when fetchWebStatus returns null (404)', async () => {
      mockFetchWebStatus.mockResolvedValue(null);

      const { queryByText, findByText } = renderScreen();

      // Wait for the component to finish loading (encounter data renders)
      await findByText('Clinical Note');

      // No banner text should be present
      expect(queryByText(/modified on the web/i)).toBeNull();
    });

    it('shows no banner when fetchWebStatus throws a network error', async () => {
      mockFetchWebStatus.mockRejectedValue(new Error('Network request failed'));

      const { queryByText, findByText } = renderScreen();

      // Wait for the component to finish loading
      await findByText('Clinical Note');

      // No banner or error indication
      expect(queryByText(/modified on the web/i)).toBeNull();
    });

    it('shows no banner when fetchWebStatus throws a timeout error', async () => {
      mockFetchWebStatus.mockRejectedValue(new Error('AbortError: timeout'));

      const { queryByText, findByText } = renderScreen();

      // Wait for the component to finish loading
      await findByText('Clinical Note');

      expect(queryByText(/modified on the web/i)).toBeNull();
    });
  });

  describe('Non-blocking fetch (render before response)', () => {
    it('renders encounter content before web-status response arrives', async () => {
      // Make web-status take a long time (never resolves during initial check)
      let resolveWebStatus!: (value: any) => void;
      mockFetchWebStatus.mockImplementation(
        () => new Promise((resolve) => { resolveWebStatus = resolve; })
      );

      const { findByText, queryByText } = renderScreen();

      // Encounter content should render without waiting for web-status
      await findByText('Clinical Note');

      // Web-status was called but hasn't resolved yet — content is already visible
      expect(mockFetchWebStatus).toHaveBeenCalledWith('test-encounter-123');
      // No banner yet since web-status hasn't resolved
      expect(queryByText(/modified on the web/i)).toBeNull();

      // Clean up: resolve the pending promise
      await act(async () => {
        resolveWebStatus(null);
      });
    });

    it('encounter loading state does not depend on web-status fetch', async () => {
      // Web-status rejects immediately, but encounter data loads fine
      mockFetchWebStatus.mockRejectedValue(new Error('timeout'));

      const { findByText } = renderScreen();

      // Encounter content should still load and render
      await findByText('Clinical Note');
    });
  });

  describe('Re-fetch on screen focus return', () => {
    it('calls fetchWebStatus again when screen regains focus', async () => {
      mockFetchWebStatus.mockResolvedValue(null);

      const { findByText } = renderScreen();

      // Wait for initial render to complete
      await findByText('Clinical Note');

      // Initial fetch on mount/focus
      expect(mockFetchWebStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchWebStatus).toHaveBeenCalledWith('test-encounter-123');

      // Simulate screen regaining focus by calling the stored callback again
      mockFetchWebStatus.mockResolvedValue({
        status: 'Provider Edited',
        edited_at: '2025-01-15T10:30:00Z',
        edited_by: 'Dr. Smith',
        soap_version: 3,
      });

      // Get the callback that was passed to useFocusEffect and call it again
      const focusCallback = mockUseFocusEffect.mock.calls[0][0];
      await act(async () => {
        focusCallback();
      });

      await waitFor(() => {
        expect(mockFetchWebStatus).toHaveBeenCalledTimes(2);
      });
    });

    it('uses useFocusEffect to trigger web-status fetch on focus', async () => {
      mockFetchWebStatus.mockResolvedValue(null);

      renderScreen();

      // Verify that useFocusEffect was called (the hook was used)
      expect(mockUseFocusEffect).toHaveBeenCalled();

      // The callback passed to useFocusEffect should trigger fetchWebStatus
      await waitFor(() => {
        expect(mockFetchWebStatus).toHaveBeenCalledWith('test-encounter-123');
      });
    });
  });

  describe('WebStatusBanner shouldShowBanner logic', () => {
    it('returns true for "Provider Edited"', () => {
      const status: WebStatus = { status: 'Provider Edited', edited_at: '2025-01-15T10:30:00Z', edited_by: 'Dr. Smith', soap_version: 3 };
      expect(shouldShowBanner(status)).toBe(true);
    });

    it('returns true for "Provider Reviewed"', () => {
      const status: WebStatus = { status: 'Provider Reviewed', edited_at: '2025-01-15T10:30:00Z', edited_by: 'Dr. Jones', soap_version: 2 };
      expect(shouldShowBanner(status)).toBe(true);
    });

    it('returns true for "MT Reviewed"', () => {
      const status: WebStatus = { status: 'MT Reviewed', edited_at: '2025-01-15T10:30:00Z', edited_by: 'MT Team', soap_version: 1 };
      expect(shouldShowBanner(status)).toBe(true);
    });

    it('returns false for null', () => {
      expect(shouldShowBanner(null)).toBe(false);
    });

    it('returns false for unknown status', () => {
      const status: WebStatus = { status: 'Unknown Status', edited_at: '2025-01-15T10:30:00Z', edited_by: 'Someone', soap_version: 1 };
      expect(shouldShowBanner(status)).toBe(false);
    });
  });
});
