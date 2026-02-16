(() => {
  const msg = document.getElementById('verifyMsg');

  const AUTH_CODE_TO_KEY = {
    token_required: 'verify.error.token_required',
    token_invalid_or_expired: 'verify.error.token_invalid_or_expired',
    token_wrong_type: 'verify.error.token_wrong_type',
    token_payload_invalid: 'verify.error.token_payload_invalid',
    token_invalid: 'verify.error.token_invalid',
    token_revoked: 'verify.error.token_revoked',
    token_expired: 'verify.error.token_expired',
    email_unverified: 'verify.error.email_unverified',
    user_not_found: 'verify.error.user_not_found',
  };

  function tr(key) {
    try {
      const dict = window.__shogiMessages || {};
      const k = String(key || '').replace(/\s+/g, ' ').trim();
      return (dict[k] ?? dict[key]) ?? '';
    } catch {
      return '';
    }
  }

  function setMsg(key, ok) {
    if (!msg) return;
    msg.textContent = tr(key || '');
    msg.style.color = ok ? '#2f6b2f' : '#b04444';
  }

  function waitI18nReady(timeoutMs = 2000) {
    if (window.__shogiI18nReady) return Promise.resolve();
    return new Promise((resolve) => {
      const start = Date.now();
      const onReady = () => {
        window.removeEventListener('shogi_i18n_ready', onReady);
        resolve();
      };
      window.addEventListener('shogi_i18n_ready', onReady);
      const id = setInterval(() => {
        if (window.__shogiI18nReady || (Date.now() - start) > timeoutMs) {
          clearInterval(id);
          window.removeEventListener('shogi_i18n_ready', onReady);
          resolve();
        }
      }, 50);
    });
  }

  (async () => {
    await waitI18nReady();
    setMsg('verify.status.verifying', true);

    const sp = new URLSearchParams(location.search);
    const token = (sp.get('token') || '').trim();
    if (!token) {
      setMsg('verify.error.token_missing', false);
      return;
    }

    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.success === false) {
        const code = data && (data.error_code || data.code);
        const key = (code && AUTH_CODE_TO_KEY[code]) || 'verify.error.failed';
        setMsg(key, false);
        return;
      }
      setMsg('verify.status.verified', true);
    } catch (e) {
      setMsg('verify.error.network', false);
    }
  })();
})();