import { useCallback, useEffect, useState } from 'react';
import { FirstRunPanel, RepositoryLoadErrorPanel } from './app/components/Panels.tsx';
import { PlanEditorView } from './app/components/PlanEditorView.tsx';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import type { WalkthroughFileError } from './app/components/WalkthroughFileError.tsx';
import { RepositoryReviewHost } from './app/RepositoryReviewHost.tsx';
import { createDefaultConfig } from './config/defaults.ts';
import type { CodiffConfig } from './config/types.ts';
import {
  defaultAgentSkillStatus,
  defaultLaunchOptions,
  defaultTerminalHelperStatus,
  getAgentLabel,
} from './lib/app-constants.ts';
import type { RepositoryLoadError } from './lib/app-types.ts';
import { sortFiles } from './lib/files.ts';
import { consumeReloadSelection } from './lib/reload-selection.ts';
import {
  resolveReloadSourceForLaunch,
  resolveRepositoryReviewBootstrap,
  type RepositoryReviewBootstrap,
} from './lib/repository-review-bootstrap.ts';
import { getRepositoryLoadError } from './lib/source.ts';
import type {
  AgentSkillStatus,
  CodiffFeatureFlags,
  CodiffLaunchOptions,
  CodiffMarkdownDocument,
  GitIdentity,
  NarrativeWalkthroughResult,
  TerminalHelperStatus,
} from './types.ts';

const defaultConfig = createDefaultConfig();
const defaultFeatures: CodiffFeatureFlags = {
  planSharing: false,
  walkthroughSharing: false,
};

export default function App() {
  const [agentSkillInstalling, setAgentSkillInstalling] = useState(false);
  const [agentSkillStatus, setAgentSkillStatus] =
    useState<AgentSkillStatus>(defaultAgentSkillStatus);
  const [config, setConfig] = useState<CodiffConfig>(defaultConfig);
  const [features, setFeatures] = useState<CodiffFeatureFlags>(defaultFeatures);
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);
  const [gitIdentityReady, setGitIdentityReady] = useState(false);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>(defaultLaunchOptions);
  const [launchOptionsLoaded, setLaunchOptionsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<RepositoryLoadError | null>(null);
  const [planDocument, setPlanDocument] = useState<CodiffMarkdownDocument | null>(null);
  const [planLoadError, setPlanLoadError] = useState<string | null>(null);
  const [repositoryBootstrap, setRepositoryBootstrap] = useState<RepositoryReviewBootstrap | null>(
    null,
  );
  const [terminalHelperInstalling, setTerminalHelperInstalling] = useState(false);
  const [terminalHelperStatus, setTerminalHelperStatus] = useState<TerminalHelperStatus>(
    defaultTerminalHelperStatus,
  );
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughResult, setWalkthroughResult] = useState<NarrativeWalkthroughResult>();
  const [walkthroughFileError, setWalkthroughFileError] = useState<WalkthroughFileError | null>(
    null,
  );

  useEffect(() => {
    let canceled = false;

    const loadOptionalBootstrap = () => {
      void window.codiff.getConfig().then(
        (nextConfig) => {
          if (!canceled) {
            setConfig(nextConfig);
          }
        },
        () => {},
      );
      void window.codiff.getFeatureFlags().then(
        (nextFeatures) => {
          if (!canceled) {
            setFeatures(nextFeatures);
          }
        },
        () => {},
      );
      void window.codiff.getAgentSkillStatus().then(
        (nextStatus) => {
          if (!canceled) {
            setAgentSkillStatus(nextStatus);
          }
        },
        () => {},
      );
      void window.codiff.getTerminalHelperStatus().then(
        (nextStatus) => {
          if (!canceled) {
            setTerminalHelperStatus(nextStatus);
          }
        },
        () => {},
      );
    };

    void window.codiff.getLaunchOptions().then(
      (options) => {
        if (canceled) {
          return;
        }
        setLaunchOptions(options);
        setLaunchOptionsLoaded(true);
        loadOptionalBootstrap();

        if (options.planFile) {
          void window.codiff
            .getMarkdownDocument({ kind: 'plan', path: options.planFile })
            .then((document) => {
              if (!canceled) {
                setPlanDocument(document);
                setPlanLoadError(null);
              }
            })
            .catch((error: unknown) => {
              if (!canceled) {
                setPlanLoadError(error instanceof Error ? error.message : String(error));
              }
            });
          return;
        }

        const reloadSelection = consumeReloadSelection();
        void window.codiff
          .getRepositoryState(resolveReloadSourceForLaunch(reloadSelection, options))
          .then((loadedState) => {
            if (canceled) {
              return;
            }
            const state = { ...loadedState, files: sortFiles(loadedState.files) };
            const bootstrap = resolveRepositoryReviewBootstrap({
              launchOptions: options,
              reloadSelection,
              state,
            });
            setRepositoryBootstrap(bootstrap);
            setLoadError(null);

            if (!options.walkthrough && !options.walkthroughFile) {
              setWalkthroughLoading(false);
              setWalkthroughResult(undefined);
              setWalkthroughFileError(null);
              return;
            }

            setWalkthroughLoading(true);
            void window.codiff
              .getNarrativeWalkthrough(
                state.source,
                bootstrap.forceInitialWalkthrough ? { force: true } : undefined,
              )
              .catch((error: unknown): NarrativeWalkthroughResult => ({
                reason: error instanceof Error ? error.message : String(error),
                status: 'unavailable',
              }))
              .then((result) => {
                if (canceled) {
                  return;
                }
                setWalkthroughLoading(false);
                setWalkthroughResult(result);
                setWalkthroughFileError(
                  options.walkthroughFile && result.status === 'unavailable'
                    ? { path: options.walkthroughFile, reason: result.reason }
                    : null,
                );
              });
          })
          .catch((error: unknown) => {
            if (!canceled) {
              setLoadError(getRepositoryLoadError(error));
            }
          });
      },
      (error: unknown) => {
        if (!canceled) {
          setLaunchOptionsLoaded(true);
          setLoadError(getRepositoryLoadError(error));
        }
      },
    );

    const unsubscribe = window.codiff.onConfigChanged(setConfig);
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    window.codiff.getGitIdentity().then(
      (identity) => {
        if (!canceled) {
          setGitIdentity(identity);
          setGitIdentityReady(true);
        }
      },
      () => {
        if (!canceled) {
          setGitIdentity(null);
          setGitIdentityReady(true);
        }
      },
    );
    return () => {
      canceled = true;
    };
  }, []);

  const installTerminalHelper = useCallback(() => {
    setTerminalHelperInstalling(true);
    window.codiff
      .installTerminalHelper()
      .then(setTerminalHelperStatus)
      .catch(() => setTerminalHelperStatus(defaultTerminalHelperStatus))
      .finally(() => setTerminalHelperInstalling(false));
  }, []);

  const installAgentSkill = useCallback(() => {
    setAgentSkillInstalling(true);
    window.codiff
      .installAgentSkill()
      .then(setAgentSkillStatus)
      .catch(() => setAgentSkillStatus(defaultAgentSkillStatus))
      .finally(() => setAgentSkillInstalling(false));
  }, []);

  if (!launchOptionsLoaded) {
    return <main className="loading pulse">Loading…</main>;
  }

  if (launchOptions.planFile) {
    if (planLoadError) {
      return (
        <main className="empty-state">
          <div className="empty-panel squircle">
            <strong>Could not open plan</strong>
            <span>{planLoadError}</span>
          </div>
        </main>
      );
    }
    return planDocument ? (
      <PlanEditorView document={planDocument} shareEnabled={features.planSharing} />
    ) : (
      <main className="loading">Loading…</main>
    );
  }

  if (loadError) {
    const showFirstRun =
      loadError.kind === 'not-a-repository' &&
      !launchOptions.repositoryPathProvided &&
      !terminalHelperStatus.installed;
    const agentLabel = getAgentLabel(launchOptions.agentBackend ?? config.settings.agentBackend);

    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          {showFirstRun ? (
            <FirstRunPanel
              agentSkillInstalled={agentSkillStatus.installed}
              agentSkillInstalling={agentSkillInstalling}
              agentSkillLabel={`${agentLabel} Skill`}
              installing={terminalHelperInstalling}
              onInstallAgentSkill={installAgentSkill}
              onInstallTerminalHelper={installTerminalHelper}
            />
          ) : (
            <RepositoryLoadErrorPanel error={loadError} />
          )}
        </div>
      </main>
    );
  }

  const isWalkthroughBootstrap = Boolean(
    launchOptions.walkthrough || launchOptions.walkthroughFile,
  );
  if (!repositoryBootstrap) {
    return (
      <main className={`loading${isWalkthroughBootstrap ? ' codex' : ' pulse'}`}>
        {isWalkthroughBootstrap ? (
          <WalkthroughProgress phase={null} responseLabelIndex={0} stageRevision={0} />
        ) : (
          'Loading repository…'
        )}
      </main>
    );
  }

  return (
    <RepositoryReviewHost
      bootstrap={repositoryBootstrap}
      config={config}
      gitIdentity={gitIdentity}
      gitIdentityReady={gitIdentityReady}
      initialHistoryLoading
      initialWalkthroughFileError={walkthroughFileError}
      initialWalkthroughLoading={walkthroughLoading}
      initialWalkthroughResult={walkthroughResult}
      key={
        repositoryBootstrap.source.type === 'working-tree'
          ? repositoryBootstrap.state.root
          : JSON.stringify(repositoryBootstrap.source)
      }
      launchOptions={launchOptions}
      walkthroughSharingEnabled={features.walkthroughSharing}
    />
  );
}
