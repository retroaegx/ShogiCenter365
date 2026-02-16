
import React, { useState, useEffect } from 'react';
import { t, getLanguage } from '@/i18n';
import LoginForm from '@/components/auth/LoginForm';
import RegisterForm from '@/components/auth/RegisterForm';
import GoogleProfileSetupForm from '@/components/auth/GoogleProfileSetupForm';
import GuestLoginForm from '@/components/auth/GuestLoginForm';
import AuthTabbedContainer from '@/components/auth/AuthTabbedContainer';

const TopStaticShogi = ({ onGotoLobby }) => {

  const lang = getLanguage();
  const heroLogoSrc = lang === 'ja'
    ? '/shogi-assets/hero_logo.png'
    : '/shogi-assets/hero_logo_global.png';

  useEffect(() => {
    // Static top screen uses the same header/footer as static HTML pages.
    document.body.classList.add('shogi-static-body');

    
// Load shell script (versioned to avoid stale cache)
const SHELL_VERSION = 'static-v10';
const shellSrc = `/shogi-assets/static_shell.js?v=${SHELL_VERSION}`;

if (!window.__shogiStaticShellLoaded || window.__shogiStaticShellVersion !== SHELL_VERSION) {
  const shell = document.createElement('script');
  shell.src = shellSrc;
  shell.defer = true;
  shell.dataset.shogiStaticShell = SHELL_VERSION;
  document.body.appendChild(shell);
  shell.onload = () => {
    window.__shogiStaticShellLoaded = true;
    window.__shogiStaticShellVersion = SHELL_VERSION;
    if (typeof window.initShogiStaticShell === 'function') {
      window.initShogiStaticShell();
    }
  };
} else if (typeof window.initShogiStaticShell === 'function') {
  window.initShogiStaticShell();
}

    return () => {
      document.body.classList.remove('shogi-static-body');
    };
  }, []);
  const [posts, setPosts] = useState([]);
  const [postsError, setPostsError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/public/blog/latest', { cache: 'no-store' });
        if (!res.ok) throw new Error('http ' + res.status);
        const data = await res.json();
        if (cancelled) return;
        setPosts(Array.isArray(data?.items) ? data.items : []);
      } catch (e) {
        if (cancelled) return;
        setPosts([]);
        setPostsError(t('ui.components.top.topstaticshogi.ka0bb9f51'));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [tab, setTab] = useState('login');
  const [googlePending, setGooglePending] = useState(null);
  const [googleReturnTab, setGoogleReturnTab] = useState('login');

  const activeTab = tab === 'googleComplete' ? googleReturnTab : tab;


  return (
    <div className="shogi-static">
      <div id="staticHeader" />

      <main>
        <section className="hero">
          <div className="container hero-inner">
            <div className="hero-copy">
              <img className="hero-logo" src={heroLogoSrc} alt={t("ui.components.top.topstaticshogi.k883dcacc")} />
            </div>

            <aside className="account-card" aria-labelledby="accountTitle">
              <h2 id="accountTitle">{t("ui.components.top.topstaticshogi.k7a36931a")}</h2>

              <AuthTabbedContainer
                ariaLabel={t("ui.components.top.topstaticshogi.k4568955d")}
                className="mt-2"
                tabs={[
                  { key: 'login', label: t('ui.components.top.topstaticshogi.k417181d1') },
                  { key: 'register', label: t('ui.components.top.topstaticshogi.k97012002') },
                  { key: 'guest', label: t('ui.components.top.topstaticshogi.k896be4bc') },
                ]}
                activeKey={activeTab}
                onChange={(k) => {
                  setTab(k);
                  if (k !== 'googleComplete') setGooglePending(null);
                }}
              >
                {tab === 'login' ? (
                  <LoginForm
                    embedded
                    onLoginSuccess={onGotoLobby}
                    onSwitchToRegister={() => setTab('register')}
                    onGoogleNeedsProfile={(data) => {
                      setGooglePending(data);
                      setGoogleReturnTab('login');
                      setTab('googleComplete');
                    }}
                  />
                ) : tab === 'guest' ? (
                  <GuestLoginForm embedded onLoginSuccess={onGotoLobby} />
                ) : tab === 'googleComplete' ? (
                  <GoogleProfileSetupForm
                    embedded
                    pending={googlePending}
                    onCancel={() => setTab(googleReturnTab)}
                    onComplete={onGotoLobby}
                  />
                ) : (
                  <RegisterForm
                    embedded
                    onRegisterSuccess={() => setTab('login')}
                    onSwitchToLogin={() => setTab('login')}
                    onGoogleSuccess={onGotoLobby}
                    onGoogleNeedsProfile={(data) => {
                      setGooglePending(data);
                      setGoogleReturnTab('register');
                      setTab('googleComplete');
                    }}
                  />
                )}
              </AuthTabbedContainer>
            </aside>
          </div>
        </section>
      
        <section className="news news-listing">
          <div className="container">
            <h2 className="news-heading">{t("ui.components.top.topstaticshogi.k28eeac5d")}</h2>
            <ul className="news-list">
              {posts && posts.length ? posts.map((p) => (
                <li className="news-row" key={p.id || (p.date + p.title)}>
                  <time dateTime={p.date || ""}>{p.date || ""}</time>
                  <a className="news-title" href={p.id ? ("/blog/" + p.id) : "#"}>{p.title || ""}</a>
                </li>
              )) : (
                <li className="news-row" key="empty">
                  <time />
                  <span className="news-title">{postsError ? postsError : t('ui.components.top.topstaticshogi.kc755d199')}</span>
                </li>
              )}
            </ul>
          </div>
        </section>
    </main>

      <div id="staticFooter" />
    </div>
  );
};

export default TopStaticShogi;
