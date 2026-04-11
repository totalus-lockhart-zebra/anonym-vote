function shortAddr(addr: string) {
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

interface Props {
  voters: string[];
  totalVoted: number;
  loading: boolean;
}

export default function ParticipantsScreen({
  voters,
  totalVoted,
  loading,
}: Props) {
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
        <span className="part-pill total">{voters.length} total</span>
      </div>

      <div className="part-list">
        {voters.map((addr) => (
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
          <strong>Public:</strong> the list of eligible voters, every
          announced voting key, and every vote remark published on
          chain.
          <br />
          <strong>Private:</strong> which ring member signed a given
          vote. Each vote is ring-signed by a voting key the voter
          announced earlier, then published by a throwaway gas wallet
          that is unrelated to their real account. On-chain data never
          links a choice back to a real voter.
        </p>
      </div>
    </div>
  );
}
