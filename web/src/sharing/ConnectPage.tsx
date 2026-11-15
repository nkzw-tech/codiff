import { Thinking } from '@nkzw/codiff-core/react';
import type { UploadIntent } from '@nkzw/codiff-service/views';
import { useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { type ViewRef, useFateClient, useLiveView, useRequest, view } from 'react-fate';
import { auth } from 'void/client/react';
import { routeUrl } from 'void/routes';
import { errorMessage, signInWithGitHub, usePageTitle } from './utils.ts';

const UploadIntentView = view<UploadIntent>()({
  expiresAt: true,
  id: true,
  shareKind: true,
  status: true,
  walkthroughSlug: true,
});

const requestFor = (code: string) => ({
  uploadIntentByCode: {
    args: { code },
    view: UploadIntentView,
  },
});

const Status = ({
  action,
  detail,
  title,
}: {
  action?: React.ReactNode;
  detail?: string;
  title?: string;
}) => (
  <main className="codiff-connect-page">
    <section className="codiff-connect-status">
      {title ? <strong>{title}</strong> : <Thinking />}
      {detail ? <p>{detail}</p> : null}
      {action}
    </section>
  </main>
);

const IntentStatus = ({
  code,
  uploadIntent: uploadIntentRef,
}: {
  code: string;
  uploadIntent: ViewRef<'UploadIntent'>;
}) => {
  const fate = useFateClient();
  const intent = useLiveView(UploadIntentView, uploadIntentRef);
  const expiresAt = new Date(intent.expiresAt).getTime();
  const [expired, setExpired] = useState(() => expiresAt <= Date.now());

  useEffect(() => {
    if (intent.status === 'uploaded' && intent.walkthroughSlug) {
      window.location.replace(
        routeUrl(intent.shareKind === 'plan' ? '/p/[slug]' : '/w/[slug]', {
          params: { slug: intent.walkthroughSlug },
        }),
      );
    }
  }, [intent.shareKind, intent.status, intent.walkthroughSlug]);

  useEffect(() => {
    if (intent.status === 'uploaded' || expired) {
      return;
    }
    const timeout = window.setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()));
    const interval = window.setInterval(() => {
      void fate.request(requestFor(code), { mode: 'network-only' }).catch(() => {});
    }, 5000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [code, expired, expiresAt, fate, intent.status]);

  return expired ? (
    <Status detail="The share link expired." title="Share link expired" />
  ) : (
    <Status />
  );
};

const Screen = ({ code }: { code: string }) => {
  const { uploadIntentByCode } = useRequest(requestFor(code));
  return uploadIntentByCode ? (
    <IntentStatus code={code} uploadIntent={uploadIntentByCode} />
  ) : (
    <Status detail="The upload link is invalid or expired." title="Unable to authorize upload" />
  );
};

export default function ConnectPage({ code }: { code: string }) {
  usePageTitle('Authorize share');
  const secret = new URLSearchParams(window.location.search).get('secret');
  const { data: session, isPending } = auth.useSession();

  if (!secret) {
    return (
      <Status detail="This share link is missing its secret." title="Unable to authorize upload" />
    );
  }
  if (isPending) {
    return <Status />;
  }
  if (!session?.user) {
    return (
      <Status
        action={
          <button className="codiff-share-sign-in" onClick={signInWithGitHub} type="button">
            Sign in with GitHub
          </button>
        }
        detail="Sign in with GitHub to publish this share."
        title="Upload authorization required"
      />
    );
  }

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <Status detail={errorMessage(error)} title="Unable to authorize upload" />
      )}
      resetKeys={[code, secret, session.user.id]}
    >
      <Screen code={code} />
    </ErrorBoundary>
  );
}
