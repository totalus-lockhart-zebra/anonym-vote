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
            Click a choice. Approve one wallet popup. Wait ~30 seconds.
            Done. The on-chain payload proves <em>some</em> ring member
            voted <em>this choice</em> — without revealing which one.
          </p>

          <ol className="hiw-steps">
            <li>
              <div className="hiw-step-num">1</div>
              <div>
                <strong>Generate a voting key</strong>
                <p>
                  Your browser generates a fresh Ristretto255 keypair
                  and saves the secret half in <code>localStorage</code>.
                  The public half is the only thing that ever leaves
                  the browser. A new key is generated for each
                  proposal — no cross-proposal linkability.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">2</div>
              <div>
                <strong>Announce the voting key on chain</strong>
                <p>
                  Your real Polkadot wallet signs a{' '}
                  <code>system.remark</code> of the form{' '}
                  <code>
                    anon-vote-v2:announce:&lt;proposal&gt;:&lt;vkPub&gt;
                  </code>
                  . This is the only moment your real wallet
                  participates. It publishes your public voting key
                  for this proposal — not your choice.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">3</div>
              <div>
                <strong>Reconstruct the canonical ring</strong>
                <p>
                  Your browser scans the chain for all valid announce
                  remarks since the proposal started, and assembles
                  them into a deterministically-sorted list — the{' '}
                  <strong>ring</strong>. Every observer (UI, faucet,
                  late verifier) reconstructs the same ring at the
                  same block number, so signatures stay valid forever.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">4</div>
              <div>
                <strong>Ring-sign a drip request</strong>
                <p>
                  Your browser generates a fresh sr25519 <em>gas
                  wallet</em> and ring-signs the message{' '}
                  <code>
                    drip:&lt;proposal&gt;:&lt;gas&gt;:&lt;ringBlock&gt;
                  </code>{' '}
                  with your voting key secret. The faucet verifies
                  the signature, dedupes by the <strong>key
                  image</strong> (a deterministic unlinkable
                  nullifier), and transfers TAO to the gas wallet.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">5</div>
              <div>
                <strong>Ring-sign the vote, publish via gas wallet</strong>
                <p>
                  Your browser ring-signs{' '}
                  <code>
                    vote:&lt;proposal&gt;:&lt;choice&gt;:&lt;ringBlock&gt;
                  </code>{' '}
                  with the same voting key (same key image, different
                  message). Then it submits{' '}
                  <code>system.remark(...)</code> signed by the GAS
                  wallet — a throwaway address unrelated to your real
                  account.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">6</div>
              <div>
                <strong>Anyone can verify the tally</strong>
                <p>
                  Anyone with a chain RPC scans the vote remarks,
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
            <strong>Trust note.</strong> Anonymity rests on the BLSAG
            ring signature primitive. The faucet cannot link drips
            to real voters because the drip request carries only a
            ring signature and a fresh gas address — neither tied to
            your real wallet. The faucet can refuse service
            (censorship) but cannot forge or de-anonymize.
            <br /><br />
            <strong>Anonymity caveat.</strong> The ring grows as more
            voters join. The very first voter has the smallest
            anonymity set; later voters get progressively larger
            rings. The UI shows the current ring size before you
            click — wait for a few others to join if you want
            stronger anonymity.
          </div>
        </div>
      </div>
    </div>
  );
}
