import { ALLOWED_VOTERS } from '../config';

function shortAddr(addr: string) {
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

interface Props {
  totalVoted: number;
  loading: boolean;
}

export default function ParticipantsScreen({ totalVoted, loading }: Props) {
  if (loading) {
    return (
      <div className="vs-status">
        <div className="vs-spinner" />
        <p>Loading participants…</p>
      </div>
    );
  }

  return (
    <div className="part-root">
      <div className="part-summary">
        <span className="part-pill voted">{totalVoted} voted</span>
        <span className="part-pill total">{ALLOWED_VOTERS.length} total</span>
      </div>

      <div className="part-list">
        {ALLOWED_VOTERS.map((addr) => (
          <div key={addr} className="part-row">
            <div
              className="part-avatar"
              style={{ background: 'var(--bg3)', color: 'var(--text3)' }}
            >
              ?
            </div>
            <div className="part-addr">
              <span className="part-addr-full">{addr}</span>
              <span className="part-addr-short">{shortAddr(addr)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="res-privacy" style={{ marginTop: '1.5rem' }}>
        <div className="res-privacy-title">What's public vs private</div>
        <p>
          <strong>Public:</strong> the list of eligible voters, and the total
          count of valid remarks published on chain.
          <br />
          <strong>Private:</strong> which of these addresses has actually
          voted, and how. Each vote is published by a one-shot stealth
          sr25519 account generated in the voter's browser; the on-chain data
          never links back to the real wallet.
        </p>
      </div>
    </div>
  );
}
