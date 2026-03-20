import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import {
  applyLanguagePreference,
  DEFAULT_LANGUAGE,
  getStoredLanguagePreference,
  isSupportedLanguage,
} from '../../../i18n/config.js';
import { api } from '../../../utils/api';
import { clearDeviceSession, getDeviceIdentity, storeDeviceSession } from '../deviceTrust.js';
import { AUTH_ERROR_MESSAGES } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  OnboardingStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

type LanguagePreferencePayload = {
  language?: string;
  isExplicitlySet?: boolean;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setSession = useCallback((nextUser: AuthUser) => {
    setUser(nextUser);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    clearDeviceSession();
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const syncLanguagePreference = useCallback(async () => {
    const localLanguage = getStoredLanguagePreference();

    try {
      const response = await api.user.language();
      if (!response.ok) {
        throw new Error(`Language preference request failed with status ${response.status}`);
      }

      const payload = await parseJsonSafely<LanguagePreferencePayload>(response);
      const payloadLanguage = payload?.language;
      const serverLanguage = isSupportedLanguage(payloadLanguage) ? payloadLanguage : DEFAULT_LANGUAGE;
      const hasExplicitServerLanguage = payload?.isExplicitlySet === true;

      if (!hasExplicitServerLanguage && localLanguage && localLanguage !== serverLanguage) {
        const updateResponse = await api.user.updateLanguage(localLanguage);
        if (!updateResponse.ok) {
          throw new Error(`Language preference update failed with status ${updateResponse.status}`);
        }

        await applyLanguagePreference(localLanguage);
        return;
      }

      await applyLanguagePreference(serverLanguage);
    } catch (caughtError) {
      console.error('[Auth] Language preference sync failed:', caughtError);
      await applyLanguagePreference(localLanguage ?? DEFAULT_LANGUAGE);
    }
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      await syncLanguagePreference();
      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, syncLanguagePreference]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.user) {
          if (payload?.approvalRequired && payload?.requestToken) {
            return {
              success: false,
              error: payload.message || AUTH_ERROR_MESSAGES.deviceApprovalRequired,
              approvalRequired: true,
              requestToken: payload.requestToken,
            };
          }
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        if (payload.token) {
          storeDeviceSession({
            token: payload.token,
            username: payload.user.username,
            deviceId: getDeviceIdentity().deviceId,
          });
        }
        await syncLanguagePreference();
        setSession(payload.user);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession, syncLanguagePreference],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        if (payload.token) {
          storeDeviceSession({
            token: payload.token,
            username: payload.user.username,
            deviceId: getDeviceIdentity().deviceId,
          });
        }
        await syncLanguagePreference();
        setSession(payload.user);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession, syncLanguagePreference],
  );

  const logout = useCallback(() => {
    clearSession();

    void api.auth.logout().catch((caughtError: unknown) => {
      console.error('Logout endpoint error:', caughtError);
    });
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token: null,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
