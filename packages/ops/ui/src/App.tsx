import { useEffect, useState } from "react";
import { DataPage } from "./pages/DataPage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { IndexingPage } from "./pages/IndexingPage";
import { LogsPage } from "./pages/LogsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SanityPage } from "./pages/SanityPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkersPage } from "./pages/WorkersPage";

const PAGES = [
  ["overview", "Overview"],
  ["indexing", "Indexing"],
  ["workers", "Workers"],
  ["data", "Data"],
  ["sanity", "Sanity"],
  ["explorer", "Explorer"],
  ["logs", "Logs"],
  ["settings", "Settings"],
] as const;

type PageId = (typeof PAGES)[number][0];

function pageFromHash(): PageId {
  const hash = location.hash.replace("#", "") as PageId;
  return PAGES.some(([id]) => id === hash) ? hash : "overview";
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [theme, setTheme] = useState(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const index = Number(event.key) - 1;
      const next = PAGES[index];
      if (next) location.hash = next[0];
      if (event.key === "t") {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("merces-ops-theme", theme);
  }, [theme]);

  return (
    <div className="grid min-h-screen grid-cols-[220px_1fr]">
      <a className="sr-only" href="#main">
        Skip to content
      </a>
      <nav className="border-r border-[var(--line)] p-4" aria-label="Sections">
        <div className="mb-6 text-sm font-semibold tracking-wide">Merces ops</div>
        <div className="flex flex-col gap-1">
          {PAGES.map(([id, label], index) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={page === id ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-sm ${page === id ? "bg-[var(--card)]" : ""}`}
            >
              <span className="muted mr-2">{index + 1}</span>
              {label}
            </a>
          ))}
        </div>
        <button className="btn mt-6 w-full" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "Light theme" : "Dark theme"} (t)
        </button>
        <p className="muted mt-4 text-xs">Keys 1–8 switch pages.</p>
      </nav>
      <main id="main" className="p-6">
        {page === "overview" && <OverviewPage />}
        {page === "indexing" && <IndexingPage />}
        {page === "workers" && <WorkersPage />}
        {page === "data" && <DataPage />}
        {page === "sanity" && <SanityPage />}
        {page === "explorer" && <ExplorerPage />}
        {page === "logs" && <LogsPage />}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
