import { auth } from 'void/client/react';
import darkPreview from './assets/codiff-dark.webp';
import lightPreview from './assets/codiff-light.webp';
import icon from './assets/icon.webp';
import SignInButton from './SignInButton.tsx';

const cliCommands = [
  {
    command: 'codiff',
    description: 'Open the current Git repository in Codiff.',
  },
  {
    command: 'codiff -w',
    description: 'Generate a walkthrough and open it in Codiff.',
  },
  {
    command: 'codiff pr 75',
    description: 'Open GitHub pull request 75 using the current repository.',
  },
  {
    command: 'codiff --share pr 232',
    description: 'Generate a walkthrough for pull request 232 and print its share URL.',
  },
];

export default function HomeGuide() {
  const { data: session, isPending } = auth.useSession();

  return (
    <main className="codiff-web-page codiff-web-guide">
      <div className="codiff-web-guide-hero">
        <section className="codiff-web-guide-intro">
          <img alt="" className="codiff-web-hero-icon" draggable={false} src={icon} />
          <h1>Codiff</h1>
          <p>Effective code reviews locally and on the web</p>
          <div className="codiff-web-guide-cta">
            {!isPending && !session?.user ? (
              <SignInButton size="lg" variant="default">
                Continue with GitHub
              </SignInButton>
            ) : null}
          </div>
        </section>
        <aside aria-label="Codiff preview" className="codiff-web-guide-preview">
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={darkPreview} />
            <img
              alt="A Codiff walkthrough reviewing code changes"
              draggable={false}
              height={1052}
              src={lightPreview}
              width={1600}
            />
          </picture>
        </aside>
      </div>

      <section className="codiff-web-guide-section">
        <div className="codiff-web-step">1</div>
        <div className="codiff-web-guide-content">
          <h2>Install Codiff</h2>
          <pre className="codiff-web-command">
            <code>brew install --cask nkzw-tech/tap/codiff</code>
          </pre>
        </div>
      </section>

      <section className="codiff-web-guide-section">
        <div className="codiff-web-step">2</div>
        <div className="codiff-web-guide-content">
          <h2>Install the terminal helper and agent skill</h2>
          <p>
            Open Codiff and choose <code>Codiff &gt; Install Terminal Helper</code> to make the{' '}
            <code>codiff</code> command available in your shell.
          </p>
          <p>
            Then choose <code>Codiff &gt; Install Skill</code> and select Codex, Claude Code, Pi, or
            OpenCode.
          </p>
        </div>
      </section>

      <section className="codiff-web-guide-section">
        <div className="codiff-web-step">3</div>
        <div className="codiff-web-guide-content">
          <h2>Use Codiff from your agent</h2>
          <p>
            Run <code>$codiff</code> to generate a local walkthrough within your agent session and
            open it in Codiff.
          </p>
          <p>
            Run <code>$codiff plan</code> to open an implementation plan in Codiff for review and
            editing before your agent starts executing it.
          </p>
          <p>
            Run <code>$codiff share</code> to generate an immutable shared walkthrough on{' '}
            <a href="https://codiff.dev">codiff.dev</a>. For example, run it as-is to share the
            current changes, or run <code>$codiff share pr 131</code> to share a walkthrough of pull
            request 131.
          </p>
        </div>
      </section>

      <section className="codiff-web-cli">
        <div className="codiff-web-guide-content">
          <h2>Command line</h2>
          <p>Run these commands from within a Git repository.</p>
          <div className="codiff-web-command-list">
            {cliCommands.map(({ command, description }) => (
              <article className="codiff-web-command-item" key={command}>
                <code>{command}</code>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
