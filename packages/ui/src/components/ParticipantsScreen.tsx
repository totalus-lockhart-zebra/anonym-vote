import { useVoterIdentities } from '../hooks/useVoterIdentities';

function shortAddr(addr: string) {
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

interface Props {
  voters: string[];
  totalVoted: number;
}

/**
 * Senate view. Voters come from PROPOSAL.allowedVoters (hotkeys);
 * we additionally resolve each hotkey → coldkey → on-chain identity
 * (name) via SubtensorModule.owner + SubtensorModule.identitiesV2.
 * Identity is purely cosmetic — the protocol treats the hotkey as
 * the authoritative allowlist entry, and it's what's signed and
 * verified. Identity display degrades gracefully: while the RPC
 * round-trip is in flight we show a spinner; if either storage
 * query fails or returns null, the row just reads "unknown".
 */
export default function ParticipantsScreen({ voters, totalVoted }: Props) {
  const identities = useVoterIdentities(voters);

  // If lookup finished cleanly but literally no address has on-chain
  // identity data (typical for a senate of raw keypairs that have
  // never been registered as Subtensor validators), surface a
  // one-line hint so users don't think it's a bug.
  const anyResolved =
    !identities.loading &&
    Array.from(identities.byHotkey.values()).some(
      (i) => i.name !== null || i.coldkey !== null,
    );
  const emptyResult =
    !identities.loading && !identities.error && voters.length > 0 && !anyResolved;

  return (
    <div className="part-root">
      <div className="part-summary">
        <span className="part-pill voted">{totalVoted} voted</span>
        <span className="part-pill total">{voters.length} total</span>
      </div>

      <div className="part-list">
        {voters.map((addr) => {
          const ident = identities.byHotkey.get(addr);
          const name = ident?.name ?? null;

          return (
            <div key={addr} className="part-row">
              <div
                className="part-avatar"
                style={{ background: 'var(--bg3)', color: 'var(--text3)' }}
              >
                {name ? name.slice(0, 1).toUpperCase() : '?'}
              </div>
              <div className="part-addr">
                <div className="part-identity">
                  {identities.loading && !ident ? (
                    <span className="part-identity-loading">resolving…</span>
                  ) : name ? (
                    <span className="part-identity-name">{name}</span>
                  ) : (
                    <span className="part-identity-unknown">unknown</span>
                  )}
                </div>
                <span className="part-addr-full">{addr}</span>
                <span className="part-addr-short">{shortAddr(addr)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {identities.error && (
        <div className="part-error">
          Identity resolution failed: <code>{identities.error}</code>. Hotkeys
          are still authoritative; this only affects display.
        </div>
      )}
      {emptyResult && (
        <div className="part-hint">
          None of these addresses have on-chain identity data on the configured
          RPC. Hotkeys that aren't registered as Subtensor validators don't
          have a coldkey mapping or an <code>identitiesV2</code> record, so
          the UI shows "unknown" — the voting flow itself is unaffected.
        </div>
      )}

      <div className="res-privacy" style={{ marginTop: '1.5rem' }}>
        <div className="res-privacy-title">What's public vs private</div>
        <p>
          <strong>Public:</strong> the list of eligible voters, every announced
          voting key, and every vote remark published on chain.
          <br />
          <strong>Private:</strong> which ring member signed a given vote. Each
          vote is ring-signed by a voting key the voter announced earlier, then
          published by a throwaway gas wallet that is unrelated to their real
          account. On-chain data never links a choice back to a real voter.
        </p>
      </div>
    </div>
  );
}
