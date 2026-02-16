(() => {
  const btn = document.getElementById('resetSubmit');
  const form = document.getElementById('resetForm');
  const msg = document.getElementById('resetMsg');

  const AUTH_CODE_TO_KEY = {
    token_required: 'reset.error.token_required',
    token_invalid_or_expired: 'reset.error.token_invalid_or_expired',
    token_wrong_type: 'reset.error.token_wrong_type',
    token_payload_invalid: 'reset.error.token_payload_invalid',
    token_invalid: 'reset.error.token_invalid',
    token_revoked: 'reset.error.token_revoked',
    token_expired: 'reset.error.token_expired',

    password_update_failed: 'reset.error.update_failed',
    password_too_short: 'reset.error.password_too_short',
    password_need_upper: 'reset.error.password_need_upper',
    password_need_lower: 'reset.error.password_need_lower',
    password_need_digit: 'reset.error.password_need_digit',
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

  function validatePassword(pw) {
    if (!pw || pw.length < 8) return 'reset.error.password_too_short';
    if (!/[A-Z]/.test(pw)) return 'reset.error.password_need_upper';
    if (!/[a-z]/.test(pw)) return 'reset.error.password_need_lower';
    if (!/\d/.test(pw)) return 'reset.error.password_need_digit';
    return null;
  }

  btn?.addEventListener('click', async () => {
    if (!form) return;

    await waitI18nReady();

    const sp = new URLSearchParams(location.search);
    const token = (sp.get('token') || '').trim();
    if (!token) {
      setMsg('reset.error.token_missing', false);
      return;
    }

    const pw = (form.pw?.value || '').trim();
    const pw2 = (form.pw2?.value || '').trim();

    const err = validatePassword(pw);
    if (err) {
      setMsg(err, false);
      return;
    }
    if (pw !== pw2) {
      setMsg('reset.validation.password_mismatch', false);
      return;
    }

    btn.disabled = true;
    setMsg('reset.status.updating', true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.success === false) {
        const code = data && (data.error_code || data.code);
        const key = (code && AUTH_CODE_TO_KEY[code]) || 'reset.error.update_failed';
        setMsg(key, false);
        return;
      }
      setMsg('reset.status.updated', true);
      form.reset();
    } catch (e) {
      setMsg('reset.error.network', false);
    } finally {
      btn.disabled = false;
    }
  });
})();