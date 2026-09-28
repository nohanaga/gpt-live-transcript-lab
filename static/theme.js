(() => {
  const key = 'transcript-lab-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const validTheme = (value) => value === 'light' || value === 'dark';
  let preference = null;
  let storageMessage = '';
  let toggle;
  let status;

  const storageFailure = (error) => {
    if (!(error instanceof DOMException)
      || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error;
    storageMessage = 'テーマ設定を保存できません。この画面では切り替えられますが、再読み込み後は引き継がれません。';
    console.warn('Theme preference storage is unavailable.', error);
  };
  try {
    const stored = window.localStorage.getItem(key);
    if (validTheme(stored)) preference = stored;
  } catch (error) {
    storageFailure(error);
  }

  const applyTheme = () => {
    root.dataset.theme = preference ?? (system.matches ? 'dark' : 'light');
    if (toggle) {
      const label = root.dataset.theme === 'dark' ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      status.textContent = storageMessage;
      status.hidden = !storageMessage;
    }
    window.dispatchEvent(new Event('themechange'));
  };
  // Apply before the stylesheets and first paint, including a saved override.
  applyTheme();

  document.addEventListener('DOMContentLoaded', () => {
    toggle = document.getElementById('theme-toggle');
    status = document.getElementById('theme-status');
    toggle.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      storageMessage = '';
      try {
        window.localStorage.setItem(key, preference);
      } catch (error) {
        storageFailure(error);
      }
      applyTheme();
    });
    applyTheme();
  }, { once: true });

  system.addEventListener('change', () => {
    if (preference === null) applyTheme();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = validTheme(event.newValue) ? event.newValue : null;
    applyTheme();
  });
})();
