import { ALLOWED_VOTERS } from '../config';

function shortAddr(addr) {
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export default function ParticipantsScreen({ participants, loading }) {
  if (loading) {
    return (
      <div className="vs-status">
        <div className="vs-spinner" />
        <p>Loading participants…</p>
      </div>
    );
  }

  const voted = participants.filter((p) => p.voted).length;
  const pending = participants.filter((p) => !p.voted).length;

  return (
    <div className="part-root">
      <div className="part-summary">
        <span className="part-pill voted">{voted} voted</span>
        <span className="part-pill pending">{pending} pending</span>
        <span className="part-pill total">{ALLOWED_VOTERS.length} total</span>
      </div>

      <div className="part-list">
        {participants.map((p) => (
          <div key={p.address} className="part-row">
            <div
              className="part-avatar"
              style={{
                background: p.voted ? 'rgba(34,197,94,.15)' : 'var(--bg3)',
                color: p.voted ? '#22c55e' : 'var(--text3)',
              }}
            >
              {p.voted ? '✓' : '—'}
            </div>
            <div className="part-addr">
              <span className="part-addr-full">{p.address}</span>
              <span className="part-addr-short">{shortAddr(p.address)}</span>
            </div>
            <span className={`part-badge ${p.voted ? 'voted' : 'pending'}`}>
              {p.voted ? 'Voted' : 'Pending'}
            </span>
          </div>
        ))}
      </div>

      <div className="res-privacy" style={{ marginTop: '1.5rem' }}>
        <div className="res-privacy-title">What's public vs private</div>
        <p>
          <strong>Public:</strong> who submitted a vote (address + status
          above).
          <br />
          <strong>Private until deadline:</strong> how each person voted —
          stored as a tlock ciphertext. Even reading the raw GitHub files
          reveals nothing until drand publishes the beacon at the deadline.
        </p>
      </div>
    </div>
  );
}
