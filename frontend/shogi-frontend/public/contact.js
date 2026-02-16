(() => {
  const btn = document.getElementById('contactSubmit');
  const form = document.getElementById('contactForm');
  const msg = document.getElementById('contactMsg');

  const CONTACT_CODE_TO_KEY = {
    contact_smtp_not_configured: 'contact.error.smtp_not_configured',
    contact_receiver_not_configured: 'contact.error.receiver_not_configured',
    contact_missing_fields: 'contact.error.missing_fields',
    contact_invalid_input: 'contact.error.invalid_input',
    contact_invalid_email: 'contact.error.invalid_email',
    contact_body_too_long: 'contact.error.body_too_long',
    contact_send_failed: 'contact.error.send_failed',
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

  btn?.addEventListener('click', async () => {
    if (!form) return;

    await waitI18nReady();

    const email = (form.email?.value || '').trim();
    const email2 = (form.email2?.value || '').trim();
    if (email !== email2) {
      setMsg('contact.validation.email_mismatch', false);
      return;
    }
    if (!form.reportValidity()) return;

    const payload = {
      name: (form.name?.value || '').trim(),
      subject: (form.subject?.value || '').trim(),
      email,
      body: (form.body?.value || '').trim(),
    };

    btn.disabled = true;
    setMsg('contact.status.sending', true);
    try {
      const res = await fetch('/api/public/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.success === false) {
        const code = data && (data.error_code || data.code);
        const key = (code && CONTACT_CODE_TO_KEY[code]) || 'contact.error.send_failed';
        setMsg(key, false);
        return;
      }
      setMsg('contact.status.sent', true);
      form.reset();
    } catch (e) {
      setMsg('contact.error.network', false);
    } finally {
      btn.disabled = false;
    }
  });
})();