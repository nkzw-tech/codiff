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
  HISTORY_PAGE_SIZE,
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
  HistoryEntry,
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
  const [history, setHistory] = useState<ReadonlyArray<HistoryEntry>>([]);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>(defaultLaunchOptions);
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
  const [walkthroughResult, setWalkthroughResult] = useState<NarrativeWalkthroughResult>();
  const [walkthroughFileError, setWalkthroughFileError] = useState<WalkthroughFileError | null>(
    null,
  );

  const loadRepository = useCallback(async (options: CodiffLaunchOptions) => {
    const reloadSelection = consumeReloadSelection();
    const loadedState = await window.codiff.getRepositoryState(
      resolveReloadSourceForLaunch(reloadSelection, options),
    );
    const nextState = { ...loadedState, files: sortFiles(loadedState.files) };
    const bootstrap = resolveRepositoryReviewBootstrap({
      launchOptions: options,
      reloadSelection,
      state: nextState,
    });
    const nextHistory = await window.codiff.getRepositoryHistory(
      HISTORY_PAGE_SIZE,
      bootstrap.historySource ?? undefined,
    );
    const shouldLoadWalkthrough = Boolean(options.walkthrough || options.walkthroughFile);
    const result = shouldLoadWalkthrough
      ? await window.codiff.getNarrativeWalkthrough(
          nextState.source,
          bootstrap.forceInitialWalkthrough ? { force: true } : undefined,
        )
      : undefined;

    setHistory(nextHistory.entries);
    setWalkthroughResult(result);
    if (options.walkthroughFile && result?.status === 'unavailable') {
      setRepositoryBootstrap({ ...bootstrap, sidebarMode: 'history' });
      setWalkthroughFileError({ path: options.walkthroughFile, reason: result.reason });
    } else {
      setRepositoryBootstrap(bootstrap);
      setWalkthroughFileError(null);
    }
    setLoadError(null);
  }, []);

  useEffect(() => {
    let canceled = false;
    let loadingPlan = false;

    const load = async () => {
      const options = await window.codiff.getLaunchOptions();
      if (canceled) {
        return;
      }
      setLaunchOptions(options);

      const [nextConfig, nextFeatures, nextAgentSkillStatus, nextTerminalHelperStatus] =
        await Promise.all([
          window.codiff.getConfig(),
          window.codiff.getFeatureFlags(),
          window.codiff.getAgentSkillStatus().catch(() => defaultAgentSkillStatus),
          window.codiff.getTerminalHelperStatus().catch(() => defaultTerminalHelperStatus),
        ]);
      if (canceled) {
        return;
      }
      setConfig(nextConfig);
      setFeatures(nextFeatures);
      setAgentSkillStatus(nextAgentSkillStatus);
      setTerminalHelperStatus(nextTerminalHelperStatus);

      if (options.planFile) {
        loadingPlan = true;
        const document = await window.codiff.getMarkdownDocument({
          kind: 'plan',
          path: options.planFile,
        });
        if (!canceled) {
          setPlanDocument(document);
          setPlanLoadError(null);
        }
        return;
      }
      await loadRepository(options);
    };

    load().catch((error: unknown) => {
      if (!canceled) {
        if (loadingPlan) {
          setPlanLoadError(error instanceof Error ? error.message : String(error));
        } else {
          setLoadError(getRepositoryLoadError(error));
        }
      }
    });

    const unsubscribe = window.codiff.onConfigChanged(setConfig);
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [loadRepository]);

  useEffect(() => {
    let canceled = false;
    window.codiff.getGitIdentity().then(
      (identity) => {
        if (!canceled) {
          setGitIdentity(identity);
        }
      },
      () => {
        if (!canceled) {
          setGitIdentity(null);
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
      initialHistory={history}
      initialWalkthroughFileError={walkthroughFileError}
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
