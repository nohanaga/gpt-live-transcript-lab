// Decide the UI language before first paint (classic script, loaded before theme.js).
// Priority: ?lang=ja|en in the URL, then the saved choice, then the browser language.
// The result is stored on <html lang>, which i18n.js, theme.js, and the CSS read.
(() => {
  const key = 'transcript-lab-language';
  const supported = (value) => value === 'ja' || value === 'en';
  let language = null;
  try {
    const requested = new URLSearchParams(window.location.search).get('lang');
    if (supported(requested)) {
      language = requested;
      window.localStorage.setItem(key, requested);
    }
  } catch {
    // Blocked storage only means the choice is not remembered.
  }
  if (!language) {
    try {
      const saved = window.localStorage.getItem(key);
      if (supported(saved)) language = saved;
    } catch {
      // Fall back to the browser language below.
    }
  }
  if (!language) {
    const preferred = window.navigator.languages?.[0] ?? window.navigator.language ?? 'ja';
    language = /^ja\b/i.test(preferred) ? 'ja' : 'en';
  }
  document.documentElement.lang = language;
})();
