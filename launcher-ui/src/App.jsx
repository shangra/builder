import { useEffect, useMemo, useState } from 'react';

export default function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [activeId, setActiveId] = useState('home');
  const [openedIds, setOpenedIds] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/state', { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) {
            throw new Error('Не удалось прочитать состояние коробки');
          }
          return response.json();
        })
        .then((data) => {
          if (!cancelled) {
            setState(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err.message);
          }
        });

    load();
    const timer = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const activeApp = useMemo(
    () => state?.apps.find((app) => app.id === activeId) || null,
    [state, activeId],
  );

  if (error) {
    return <div className="boot-error">{error}</div>;
  }
  if (!state) {
    return <div className="boot-error">Загрузка лаунчера…</div>;
  }

  const openApp = (app) => {
    if (state.mode === 'browser' && app.url) {
      window.open(app.url, '_blank', 'noopener');
    }
    setActiveId(app.id);
    setOpenedIds((current) => (current.includes(app.id) ? current : [...current, app.id]));
  };

  const goHome = () => setActiveId('home');
  const isHome = activeId === 'home';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">{state.product}</div>
            <div className="brand-meta">v{state.version}</div>
          </div>
        </div>
        <nav className="nav">
          <NavButton id="home" active={isHome} onClick={goHome} label="Главная" sub="Разделы продукта" />
          {state.apps.map((app) => (
            <NavButton
              key={app.id}
              id={app.id}
              active={activeId === app.id}
              onClick={() => openApp(app)}
              label={app.title}
              sub={app.subtitle || app.module}
            />
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="mode-pill">
            {state.mode === 'browser' ? 'открытие в браузере' : 'внутри лаунчера'}
          </span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{isHome ? 'Главная' : activeApp?.title}</h1>
          <p className="topbar-sub">
            {isHome
              ? 'Переход между разделами продукта'
              : activeApp?.subtitle || activeApp?.url || ''}
          </p>
        </header>
        {isHome ? (
          <section className="home">
            {state.apps.map((app) => (
              <button key={app.id} type="button" className="card" onClick={() => openApp(app)}>
                <h2>{app.title}</h2>
                <p>{app.subtitle}</p>
                <div className={app.ready ? 'status' : 'status is-wait'}>
                  {app.ready ? 'модуль доступен' : 'ожидает запуска'}
                </div>
              </button>
            ))}
          </section>
        ) : (
          <section className="stage">
            {state.mode === 'browser' && activeApp ? (
              <div className="browser-note">
                <h2>{activeApp.title}</h2>
                <p>По конфигу приложения открываются в браузере, не внутри лаунчера.</p>
                {activeApp.url ? (
                  <a href={activeApp.url} target="_blank" rel="noreferrer">
                    {activeApp.url}
                  </a>
                ) : (
                  <p>Адрес модуля ещё не известен. Дождитесь старта сервиса.</p>
                )}
              </div>
            ) : (
              state.apps.map((app) =>
                openedIds.includes(app.id) ? (
                  <div
                    key={app.id}
                    className={activeId === app.id ? 'panel is-active' : 'panel'}
                  >
                    {app.ready && app.url ? (
                      <iframe src={app.url} title={app.title} />
                    ) : (
                      <div className="browser-note">
                        <p>Модуль поднимается… страница откроется сама, когда сервис будет готов.</p>
                      </div>
                    )}
                  </div>
                ) : null,
              )
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function NavButton({ active, onClick, label, sub }) {
  return (
    <button type="button" className={active ? 'is-active' : ''} onClick={onClick}>
      <span className="nav-label">{label}</span>
      <span className="nav-sub">{sub}</span>
    </button>
  );
}
