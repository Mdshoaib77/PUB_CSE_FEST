import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'festhub-theme';

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}
export function currentTheme(): Theme {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark';
  return stored() ?? (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark');
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: preference lasts for this tab only */
  }
}

/** Theme state + toggle; the choice is saved in localStorage and synced across tabs. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const set = useCallback((t: Theme) => {
    applyTheme(t);
    setTheme(t);
  }, []);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) {
        document.documentElement.classList.toggle('dark', e.newValue === 'dark');
        setTheme(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return { theme, setTheme: set, toggle: () => set(theme === 'dark' ? 'light' : 'dark') };
}
