import { useEffect } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function HowItWorksModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="hiw-backdrop" onClick={onClose}>
      <div
        className="hiw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hiw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hiw-header">
          <h2 id="hiw-title" className="hiw-title">
            How anonymous voting works
          </h2>
          <button className="hiw-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="hiw-body">
          <p className="hiw-lead">
            Voting happens in two phases: <strong>register</strong> first,
            then <strong>vote</strong> after the coordinator opens the
            window. Both your real wallet and a throwaway gas wallet take
            turns on chain — but math (BLSAG ring signatures) and the time
            gap between the phases together ensure that nobody can link
            your real account to your vote choice.
          </p>

          <ol className="hiw-steps">
            <li>
              <div className="hiw-step-num">1</div>
              <div>
                <strong>Generate a voting key (browser, instant)</strong>
                <p>
                  Your browser generates a fresh Ristretto255 keypair and
                  saves the secret half in <code>localStorage</code>. The
                  public half is the only thing that ever leaves the
                  browser. A new key is generated for each proposal — no
                  cross-proposal linkability.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">2</div>
              <div>
                <strong>Register on chain (your real wallet)</strong>
                <p>
                  Your real Polkadot wallet signs a{' '}
                  <code>system.remark</code> of the form{' '}
                  <code>
                    anon-vote-v2:announce:&lt;proposal&gt;:&lt;vkPub&gt;
                  </code>
                  . This is the only moment your real wallet
                  participates. The remark publishes your public voting
                  key for this proposal — <em>not</em> your choice.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">3</div>
              <div>
                <strong>Wait for the coordinator to open voting</strong>
                <p>
                  After everyone has registered, the coordinator
                  publishes a special <code>start</code> remark from
                  their wallet. The UI watches for it and flips
                  automatically into the voting phase the moment it
                  lands. The gap between your registration and the
                  start signal is the protocol's defense against
                  on-chain timing-correlation — observers can no
                  longer pair "this announce" with "that vote" by
                  looking at clock times.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">4</div>
              <div>
                <strong>Cast your vote (browser, no popup)</strong>
                <p>
                  Click Yes / No / Abstain. Your browser ring-signs{' '}
                  <code>
                    drip:&lt;proposal&gt;:&lt;gas&gt;:&lt;ringBlock&gt;
                  </code>{' '}
                  with your voting key, sends it to the faucet
                  (which verifies the ring signature and funds a
                  fresh gas wallet), then ring-signs{' '}
                  <code>
                    vote:&lt;proposal&gt;:&lt;choice&gt;:&lt;ringBlock&gt;
                  </code>{' '}
                  and publishes <code>system.remark</code> from the
                  gas wallet. The gas wallet is a brand-new sr25519
                  key with no history — observers see only "some
                  fresh gas address voted X", not "you voted X".
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">5</div>
              <div>
                <strong>Anyone can verify the tally</strong>
                <p>
                  The Results tab scans the chain for vote remarks,
                  reconstructs the ring at each vote's embedded
                  ringBlock, verifies the ring signature against
                  that ring, drops second-and-later remarks with the
                  same key image, and aggregates the choices. The
                  result is a publicly verifiable count — with no
                  way to tell who voted for what.
                </p>
              </div>
            </li>
          </ol>

          <div className="hiw-caveat">
            <strong>What's hidden:</strong> the link between any real
            wallet and any vote choice. The ring signature math
            guarantees it; no one — not the chain, not the faucet, not
            other voters — can invert it.
            <br />
            <br />
            <strong>What's visible:</strong> who is registered (your
            real wallet's announce remark is on chain) and the total
            count of votes per choice. Visibility of <em>participation</em>
            but not <em>choice</em> is an inherent property of any ring-
            signature scheme.
            <br />
            <br />
            <strong>Trust the coordinator for what?</strong> Only for
            "deciding when voting opens". They cannot forge votes,
            block specific voters, or learn how anyone voted.
          </div>
        </div>
      </div>
    </div>
  );
}
