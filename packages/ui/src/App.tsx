import { useState } from 'react';
import { useWallet } from './hooks/useWallet';
import { useVotes } from './hooks/useVotes';
import { useVoters } from './hooks/useVoters';
import { useProposal } from './hooks/useProposal';
import VoteScreen from './components/VoteScreen';
import ResultsScreen from './components/ResultsScreen';
import ParticipantsScreen from './components/ParticipantsScreen';

const TABS = [
  { id: 'vote', label: 'Vote' },
  { id: 'results', label: 'Results' },
  { id: 'participants', label: 'Participants' },
];

function shortAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

export default function App() {
  const [tab, setTab] = useState('vote');
  const { voters, loading: votersLoading, error: votersError } = useVoters();
  const {
    proposal,
    loading: proposalLoading,
    error: proposalError,
  } = useProposal();
  const wallet = useWallet(voters);
  const {
    tally,
    loading,
    error,
    progress,
    alreadyVoted,
    isPastDeadline,
    refresh,
  } = useVotes(wallet.address, proposal);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <div className="logo">
            <span className="logo-mark">◈</span>
            <span className="logo-text">AnonVote</span>
          </div>
          <span className="proposal-chip">{proposal?.id ?? '…'}</span>
          {isPastDeadline && (
            <span
              className="proposal-chip"
              style={{ color: 'var(--yes)', borderColor: 'rgba(34,197,94,.3)' }}
            >
              closed
            </span>
          )}
        </div>
        <div className="topbar-right">
          {wallet.status === 'connected' ? (
            <div className="wallet-connected">
              <span
                className={`wallet-badge ${wallet.isAllowed ? 'allowed' : 'not-allowed'}`}
              >
                {wallet.isAllowed ? 'eligible voter' : 'not eligible'}
              </span>
              {wallet.accounts.length > 1 && (
                <select
                  className="account-select"
                  value={wallet.address}
                  onChange={(e) => wallet.switchAccount(e.target.value)}
                >
                  {wallet.accounts.map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.meta.name || shortAddr(a.address)}
                    </option>
                  ))}
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
      {votersError && (
        <div className="wallet-error">
          Failed to load voter list from faucet: {votersError}
        </div>
      )}
      {proposalError && (
        <div className="wallet-error">
          Failed to load proposal from faucet: {proposalError}
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
            {t.id === 'vote' && alreadyVoted && (
              <span className="tab-dot done" />
            )}
            {t.id === 'results' && tally && tally.totalVoted > 0 && (
              <span className="tab-count">{tally.totalVoted}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="content">
        {proposalLoading || !proposal ? (
          <div className="vs-status">
            <div className="vs-spinner" />
            <p>Loading proposal…</p>
          </div>
        ) : (
          <>
            {tab === 'vote' && (
              <VoteScreen
                wallet={wallet}
                alreadyVoted={alreadyVoted}
                onVoted={refresh}
                proposal={proposal}
              />
            )}
            {tab === 'results' && (
              <ResultsScreen
                tally={tally}
                loading={loading}
                error={error}
                progress={progress}
                refresh={refresh}
                isPastDeadline={isPastDeadline}
                voters={voters}
                proposal={proposal}
              />
            )}
            {tab === 'participants' && (
              <ParticipantsScreen
                voters={voters}
                totalVoted={tally?.totalVoted ?? 0}
                loading={loading || votersLoading}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
