import AppHeader from './AppHeader';

export default function AppShell({ children }) {
  return (
    <div className="min-h-screen bg-ink-50 text-ink-900">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
