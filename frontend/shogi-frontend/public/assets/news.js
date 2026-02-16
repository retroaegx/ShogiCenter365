(function(){
  function getDict() {
    try { return (window && window.__shogiMessages) ? window.__shogiMessages : {}; } catch { return {}; }
  }

  function getText(dict, key) {
    if (!dict || !key) return '';
    try {
      return Object.prototype.hasOwnProperty.call(dict, key) ? String(dict[key] ?? '') : '';
    } catch {
      return '';
    }
  }

  function render() {
    const list = document.getElementById('newsList');
    if (!list || !Array.isArray(window.SHOGI_NEWS)) return;

    const dict = getDict();
    const items = [...window.SHOGI_NEWS].sort((a,b) => (b.date||'').localeCompare(a.date||''));

    list.innerHTML = items.map(item => {
      const date = item.date || '';
      const url = item.url || '#';
      // Dictionary-only: news items should provide keys (titleKey or title) and be resolved here.
      const key = (item.titleKey || item.title || '');
      const k = String(key).replace(/\s+/g, ' ').trim();
      const title = k ? getText(dict, k) : '';

      return `<li class="news-row">
        <time datetime="${date}">${date}</time>
        <a class="news-title" href="${url}">${title}</a>
      </li>`;
    }).join('');
  }

  try {
    if (window && window.__shogiI18nReady) render();
  } catch {}

  window.addEventListener('shogi_i18n_ready', render);
  window.addEventListener('shogi_language_changed', function(){});

})();
