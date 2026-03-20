import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { api } from '../../../utils/api';
import {
  applyLanguagePreference,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
} from '../../../i18n/config.js';
import { languages } from '../../../i18n/languages';

type LanguageSelectorProps = {
  compact?: boolean;
};

const getCurrentLanguage = (language: string | undefined, resolvedLanguage: string | undefined) => {
  if (isSupportedLanguage(resolvedLanguage)) {
    return resolvedLanguage;
  }

  if (isSupportedLanguage(language)) {
    return language;
  }

  return DEFAULT_LANGUAGE;
};

const getResponseErrorMessage = async (response: Response) => {
  try {
    const payload = await response.json() as { error?: string; message?: string };
    return payload.error || payload.message || null;
  } catch {
    return null;
  }
};

/**
 * Language Selector Component
 *
 * A dropdown component for selecting the application language.
 * Automatically updates the i18n language and persists to localStorage.
 *
 * Props:
 * @param {boolean} compact - If true, uses compact style (default: false)
 */
export default function LanguageSelector({ compact = false }: LanguageSelectorProps) {
  const { i18n, t } = useTranslation('settings');
  const [isSaving, setIsSaving] = useState(false);
  const currentLanguage = getCurrentLanguage(i18n.language, i18n.resolvedLanguage);

  const handleLanguageChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = event.target.value;
    const previousLanguage = currentLanguage;

    setIsSaving(true);

    try {
      await applyLanguagePreference(nextLanguage);

      const response = await api.user.updateLanguage(nextLanguage);
      if (!response.ok) {
        const errorMessage = await getResponseErrorMessage(response);
        throw new Error(errorMessage || `Failed to update language preference: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to update language preference:', error);
      await applyLanguagePreference(previousLanguage);
      alert(t('account.languageSaveFailed', { defaultValue: 'Failed to save language preference. Please try again.' }));
    } finally {
      setIsSaving(false);
    }
  };

  // Compact style for QuickSettingsPanel
  if (compact) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-transparent bg-muted/50 p-3 transition-colors hover:border-border hover:bg-accent">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t('account.language')}
        </span>
        <select
          value={currentLanguage}
          onChange={handleLanguageChange}
          disabled={isSaving}
          className="w-[100px] rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Full style for Settings page
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <div className="text-sm font-medium text-foreground">
          {t('account.languageLabel')}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t('account.languageDescription')}
        </div>
      </div>
      <select
        value={currentLanguage}
        onChange={handleLanguageChange}
        disabled={isSaving}
        className="w-36 rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {languages.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
