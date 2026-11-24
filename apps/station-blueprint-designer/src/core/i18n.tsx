import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'ms-cad-lang';

export function loadInitialLang(): Lang {
  if (typeof window === 'undefined') return 'zh';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // ignore storage errors
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'zh';
  return nav.startsWith('zh') ? 'zh' : 'en';
}

export function formatFloorTag(floor: number): string {
  return floor < 0 ? `B${Math.abs(floor)}` : `L${floor}`;
}

export function pick<T>(lang: Lang, zh: T, en: T): T {
  return lang === 'en' ? en : zh;
}

interface I18nContextValue {
  lang: Lang;
  isEn: boolean;
  setLang: (next: Lang) => void;
  toggleLang: () => void;
  t: (zh: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'zh',
  isEn: false,
  setLang: () => {},
  toggleLang: () => {},
  t: (zh) => zh,
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(loadInitialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((prev) => {
      const next: Lang = prev === 'zh' ? 'en' : 'zh';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    }
  }, [lang]);

  const t = useCallback((zh: string, en: string) => (lang === 'en' ? en : zh), [lang]);

  return (
    <I18nContext.Provider value={{ lang, isEn: lang === 'en', setLang, toggleLang, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
