(function(){
  const list = document.getElementById('newsList');
  if (!list || !Array.isArray(window.SHOGI_NEWS)) return;
  const items = [...window.SHOGI_NEWS].sort((a,b) => (b.date||'').localeCompare(a.date||''));
  list.innerHTML = items.map(item => {
    const date = item.date || '';
    const title = item.title || '';
    const url = item.url || '#';
    return `<li class="news-row">
      <time datetime="${date}">${date}</time>
      <a class="news-title" href="${url}">${title}</a>
    </li>`;
  }).join('');
})();