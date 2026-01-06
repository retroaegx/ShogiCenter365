
import React, { useState, useEffect } from 'react';
import LoginForm from '@/components/auth/LoginForm';
import RegisterForm from '@/components/auth/RegisterForm';
import GoogleProfileSetupForm from '@/components/auth/GoogleProfileSetupForm';
import GuestLoginForm from '@/components/auth/GuestLoginForm';

const TopStaticShogi = ({ onGotoLobby }) => {

  useEffect(() => {
    // Static top screen uses the same header/footer as static HTML pages.
    document.body.classList.add('shogi-static-body');

    
// Load shell script (versioned to avoid stale cache)
const SHELL_VERSION = 'static-v6';
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
        setPostsError('お知らせの取得に失敗しました');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [tab, setTab] = useState('login');
  const [googlePending, setGooglePending] = useState(null);
  const [googleReturnTab, setGoogleReturnTab] = useState('login');


  return (
    <div className="shogi-static">
      <div id="staticHeader" />

      <main>
        <section className="hero">
          <div className="container hero-inner">
            <div className="hero-copy">
              <img className="hero-logo" src="/shogi-assets/hero_logo.png" alt="将棋センター365" />
            </div>

            <aside className="account-card" aria-labelledby="accountTitle">
              <h2 id="accountTitle">アカウント</h2>

              <div className="account-tabs" role="tablist" aria-label="アカウント切り替え">
                <button role="tab" aria-selected={tab==='login'} className={tab==='login' ? 'active' : ''} onClick={() => setTab('login')}>ログイン</button>
                <button role="tab" aria-selected={tab==='register'} className={tab==='register' ? 'active' : ''} onClick={() => setTab('register')}>新規登録</button>
                <button role="tab" aria-selected={tab==='guest'} className={tab==='guest' ? 'active' : ''} onClick={() => setTab('guest')}>ゲスト</button>
              </div>

              <div className="account-form" role="tabpanel">
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
                  <GuestLoginForm
                    onLoginSuccess={onGotoLobby}
                  />
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
              </div>
            </aside>
          </div>
        </section>
      
        <section className="news news-listing">
          <div className="container">
            <h2 className="news-heading">お知らせ</h2>
            <ul className="news-list">
              {posts && posts.length ? posts.map((p) => (
                <li className="news-row" key={p.id || (p.date + p.title)}>
                  <time dateTime={p.date || ""}>{p.date || ""}</time>
                  <a className="news-title" href={p.id ? ("/blog/" + p.id) : "#"}>{p.title || ""}</a>
                </li>
              )) : (
                <li className="news-row" key="empty">
                  <time />
                  <span className="news-title">{postsError || "お知らせはありません"}</span>
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
