import { CopyIcon as Copy } from '@phosphor-icons/react/Copy';
import { Fragment, useCallback, useLayoutEffect } from 'react';
import { statusLabel } from '../../lib/code-view-options.ts';
import { getShortRef } from '../../lib/source.ts';
import type { CommitMetadata, CommitMetadataFile } from '../../types.ts';
import { Gravatar } from './Gravatar.tsx';
import { useCopiedState } from './useCopiedState.ts';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const numberFormatter = new Intl.NumberFormat(undefined);

const formatCommitDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
};

const formatCommitCount = (value: number, singular: string, plural = `${singular}s`) =>
  `${numberFormatter.format(value)} ${value === 1 ? singular : plural}`;

const signatureLabels: Record<string, string> = {
  B: 'Bad signature',
  E: 'Signature cannot be checked',
  G: 'Verified signature',
  N: 'Unsigned commit',
  R: 'Revoked signing key',
  U: 'Untrusted signature',
  X: 'Expired signature',
  Y: 'Expired signing key',
};

const signatureLabel = (status: string) => signatureLabels[status] ?? 'Unknown signature status';

const formatSignature = (signature: CommitMetadata['signature']) => {
  let key = signature.key;
  if (key) {
    const separator = key.indexOf(':');
    if (separator > 0 && separator <= 10) {
      const prefix = key.slice(0, separator + 1);
      const value = key.slice(separator + 1);
      // Keep prefixes like SHA256: readable; shorten the fingerprint body.
      key = value.length > 12 ? `${prefix}${value.slice(0, 4)}...${value.slice(-4)}` : key;
    } else if (key.length > 24) {
      key = `${key.slice(0, 8)}...${key.slice(-8)}`;
    }
  }

  return [
    signatureLabel(signature.status),
    signature.signer ? `by ${signature.signer}` : '',
    key ? `(${key})` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

function CommitStatsChips({ stats }: { stats: CommitMetadata['stats'] }) {
  return (
    <div className="commit-details-stats">
      <span>{formatCommitCount(stats.files, 'file')}</span>
      <span className="added">+{numberFormatter.format(stats.additions)}</span>
      <span className="deleted">-{numberFormatter.format(stats.deletions)}</span>
      {stats.renamedFiles > 0 ? (
        <span>{formatCommitCount(stats.renamedFiles, 'rename')}</span>
      ) : null}
      {stats.binaryFiles > 0 ? (
        <span>{formatCommitCount(stats.binaryFiles, 'binary file')}</span>
      ) : null}
    </div>
  );
}

function CommitPersonRow({ label, person }: { label: string; person: CommitMetadata['author'] }) {
  return (
    <div className="commit-details-person">
      <span>{label}</span>
      <Gravatar
        fallback={person.name || person.email || label}
        size="small"
        url={person.gravatarUrl}
      />
      <div className="commit-details-person-body">
        <strong>{person.name || person.email}</strong>
        <small>{person.email}</small>
        <time dateTime={person.date}>{formatCommitDate(person.date)}</time>
      </div>
    </div>
  );
}

// ReviewCodeView owns filters and CodeView ids; the panel only renders resolved file rows.
export type CommitDetailsFile = CommitMetadataFile & {
  destinationItemId: string | null;
};

export function CommitDetailsPanel({
  files,
  layoutKey,
  metadata,
  onLayoutReady,
  onSelectFileDestination,
}: {
  files: ReadonlyArray<CommitDetailsFile>;
  layoutKey: string;
  metadata: CommitMetadata;
  onLayoutReady?: (layoutKey: string) => void;
  onSelectFileDestination?: (itemId: string) => void;
}) {
  const [copied, markCopied] = useCopiedState(1600);

  useLayoutEffect(() => {
    onLayoutReady?.(layoutKey);
  }, [layoutKey, onLayoutReady]);

  const copyRef = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(metadata.ref);
    } catch {
      // If copying fails, leave the button unchanged.
      return;
    }
    markCopied();
  }, [markCopied, metadata.ref]);
  const copyLabel = copied ? 'Commit hash copied' : 'Copy full commit hash';

  return (
    <section
      aria-label={`Commit details for ${getShortRef(metadata.ref)}`}
      className="commit-details-panel squircle"
    >
      <header className="commit-details-header">
        <h2>{metadata.subject || metadata.shortRef}</h2>
        <div className="commit-details-header-actions">
          <CommitStatsChips stats={metadata.stats} />
          <button
            aria-label={copyLabel}
            className={`commit-details-copy${copied ? ' copied' : ''}`}
            onClick={() => void copyRef()}
            title={copyLabel}
            type="button"
          >
            <code>{metadata.shortRef}</code>
            <Copy aria-hidden size={15} weight="bold" />
          </button>
        </div>
      </header>
      {metadata.body.trim() ? (
        <section className="commit-details-section message">
          <h3>Comment</h3>
          <pre className="commit-details-message">{metadata.body.trimEnd()}</pre>
        </section>
      ) : null}
      <section aria-label="Commit metadata" className="commit-details-grid">
        <CommitPersonRow label="Author" person={metadata.author} />
        <CommitPersonRow label="Committer" person={metadata.committer} />
        <div className="commit-details-cell">
          <h3>Refs</h3>
          {metadata.refs.length > 0 ? (
            <div className="commit-details-token-row">
              {metadata.refs.map((ref) => (
                <code key={ref}>{ref}</code>
              ))}
            </div>
          ) : (
            <p className="commit-details-empty">No refs.</p>
          )}
        </div>
        <div className="commit-details-cell">
          <h3>Parents</h3>
          {metadata.parents.length > 0 ? (
            <div className="commit-details-token-row">
              {metadata.parents.map((parent) => (
                <code key={parent}>{getShortRef(parent)}</code>
              ))}
            </div>
          ) : (
            <p className="commit-details-empty">Root commit.</p>
          )}
        </div>
        <div className="commit-details-cell commit-details-signature-cell">
          <h3>Signature</h3>
          <p className="commit-details-signature" title={metadata.signature.key}>
            {formatSignature(metadata.signature)}
          </p>
        </div>
      </section>
      {metadata.trailers.length > 0 ? (
        <section className="commit-details-section trailers">
          <h3>Trailers</h3>
          <dl className="commit-details-trailers">
            {metadata.trailers.map((trailer, index) => (
              <Fragment key={`${trailer.key}:${trailer.value}:${index}`}>
                <dt>{trailer.key}</dt>
                <dd>{trailer.value}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ) : null}
      <section className="commit-details-section files">
        <h3>Files</h3>
        <div className="commit-details-files">
          {files.map((file) => {
            const title = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
            return (
              <button
                className="commit-details-file"
                disabled={!file.destinationItemId}
                key={`${file.oldPath ?? ''}:${file.path}`}
                onClick={() => {
                  if (file.destinationItemId) {
                    onSelectFileDestination?.(file.destinationItemId);
                  }
                }}
                title={file.destinationItemId ? title : `${title} (hidden by current filters)`}
                type="button"
              >
                <span className={`codiff-status-badge ${file.status}`}>
                  {statusLabel[file.status]}
                </span>
                <code>{file.path}</code>
                {file.binary ? (
                  <span>binary</span>
                ) : (
                  <span>
                    +{numberFormatter.format(file.additions ?? 0)} -
                    {numberFormatter.format(file.deletions ?? 0)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    </section>
  );
}
