/**
 * App root.
 *
 * Proposal config is imported statically from `proposal.ts`. Every
 * remark is scanned locally by the browser indexer. The only server
 * contacted in the voting flow is the faucet, for the `/drip`
 * endpoint — and even that is trust-minimized (see faucet-drip.ts).
 *
 * No phases. There is one screen — VoteScreen — which detects its
 * own state internally (haven't announced yet → first-time flow,
 * already announced → fast vote, already voted → done state).
 *
 * Results and Participants tabs are always reachable; they're pure
 * reads of the indexer snapshot and make sense at any time.
 */

import { useState } from 'react';
import { useWallet } from './hooks/useWallet';
import { useIndexer } from './hooks/useIndexer';
import { useRing } from './hooks/useRing';
import { useTally } from './hooks/useTally';
import { useVotingPhase } from './hooks/useVotingPhase';
import { PROPOSAL } from './proposal';
import VoteScreen from './components/VoteScreen';
import ResultsScreen from './components/ResultsScreen';
import ParticipantsScreen from './components/ParticipantsScreen';
import CoordinatorScreen from './components/CoordinatorScreen';
import HowItWorksModal from './components/HowItWorksModal';

const TABS = [
  { id: 'action', label: 'Vote' },
  { id: 'results', label: 'Results' },
  { id: 'participants', label: 'Participants' },
  { id: 'coordinator', label: 'Coordinator' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function shortAddr(addr?: string | null): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function App() {
  const [tab, setTab] = useState<TabId>('action');
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  const wallet = useWallet([...PROPOSAL.allowedVoters]);
  const indexer = useIndexer(PROPOSAL);
  const ring = useRing(indexer.remarks, PROPOSAL, wallet.address ?? null);
  const phase = useVotingPhase(indexer.remarks, PROPOSAL);
  const { tally, votes, invalidReasons } = useTally(indexer.remarks, PROPOSAL);

  const isAllowlisted = Boolean(wallet.isAllowed);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <div className="logo">
            <span className="logo-mark">◈</span>
            <span className="logo-text">TaoVoter</span>
          </div>
          <span className="proposal-chip">{PROPOSAL.id}</span>
          <span
            className="proposal-chip"
            style={{ textTransform: 'capitalize' }}
          >
            {phase.phase}
          </span>
          <button
            className="hiw-trigger"
            onClick={() => setHowItWorksOpen(true)}
            aria-label="How it works"
            title="How anonymous voting works"
          >
            ?
          </button>
        </div>
        <div className="topbar-right">
          {wallet.status === 'connected' ? (
            <div className="wallet-connected">
              <span
                className={`wallet-badge ${isAllowlisted ? 'allowed' : 'not-allowed'}`}
              >
                {isAllowlisted ? 'eligible voter' : 'not eligible'}
              </span>
              {wallet.accounts.length > 1 && (
                <select
                  className="account-select"
                  value={wallet.address ?? ''}
                  onChange={(e) => wallet.switchAccount(e.target.value)}
                >
                  {wallet.accounts.map(
                    (a: { address: string; meta?: { name?: string } }) => (
                      <option key={a.address} value={a.address}>
                        {a.meta?.name || shortAddr(a.address)}
                      </option>
                    ),
                  )}
                </select>
              )}
              <span className="wallet-addr">{shortAddr(wallet.address)}</span>
              <button className="btn-disconnect" onClick={wallet.disconnect}>
                ✕
              </button>
            </div>
          ) : (
            <button
              className="btn-connect"
              onClick={wallet.connect}
              disabled={wallet.status === 'connecting'}
            >
              {wallet.status === 'connecting'
                ? 'Connecting…'
                : 'Connect wallet'}
            </button>
          )}
        </div>
      </header>

      {wallet.error && <div className="wallet-error">{wallet.error}</div>}
      {PROPOSAL.allowedVoters.length === 0 && (
        <div className="wallet-error">
          ⚠ proposal.ts has an empty <code>allowedVoters</code> list. Edit it
          and rebuild before running a real proposal.
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'results' && tally.totalVoted > 0 && (
              <span className="tab-count">{tally.totalVoted}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'action' && (
          <VoteScreen
            wallet={wallet}
            indexer={indexer}
            ring={ring}
            phase={phase}
            votes={votes}
          />
        )}

        {tab === 'results' && (
          <ResultsScreen
            indexer={indexer}
            ring={ring}
            tally={tally}
            votes={votes}
            invalidReasons={invalidReasons}
            config={PROPOSAL}
          />
        )}

        {tab === 'participants' && (
          <ParticipantsScreen
            voters={[...PROPOSAL.allowedVoters]}
            totalVoted={tally.totalVoted}
            loading={indexer.status === 'indexing'}
          />
        )}

        {tab === 'coordinator' && (
          <CoordinatorScreen wallet={wallet} phase={phase} />
        )}
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span className="footer-meta">
            Powered by{' '}
            <a
              href="https://tao.com"
              target="_blank"
              rel="noreferrer"
              className="footer-link"
            >
              tao.com
            </a>
          </span>
        </div>
      </footer>

      <HowItWorksModal
        open={howItWorksOpen}
        onClose={() => setHowItWorksOpen(false)}
      />
    </div>
  );
}
