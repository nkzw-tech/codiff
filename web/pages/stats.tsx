import Header from '../src/Header.tsx';
import PageSuspense from '../src/PageSuspense.tsx';
import StatsPage from '../src/sharing/StatsPage.tsx';

export default function Page() {
  return (
    <div className="codiff-web-shell">
      <Header />
      <PageSuspense>
        <StatsPage />
      </PageSuspense>
    </div>
  );
}
