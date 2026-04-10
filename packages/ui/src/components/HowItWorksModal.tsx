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
          <button
            className="hiw-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="hiw-body">
          <p className="hiw-lead">
            Your real wallet proves you're eligible. A throwaway{' '}
            <em>stealth</em> wallet casts the vote. Nothing on-chain links the
            two — but anyone can still verify the tally.
          </p>

          <ol className="hiw-steps">
            <li>
              <div className="hiw-step-num">1</div>
              <div>
                <strong>Stealth keypair</strong>
                <p>
                  Your browser generates a fresh sr25519 keypair (the{' '}
                  <em>stealth address</em>) and keeps it only in{' '}
                  <code>sessionStorage</code>. It has never touched the chain.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">2</div>
              <div>
                <strong>Request funding from the faucet</strong>
                <p>
                  Your <em>real</em> Polkadot wallet signs a message{' '}
                  <code>anon-vote-fund:v1:&lt;proposal&gt;:&lt;stealth&gt;</code>
                  . Note: your choice (yes/no/abstain) is <em>not</em> in this
                  signature — only a binding to the stealth address.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">3</div>
              <div>
                <strong>Faucet issues an anonymous credential</strong>
                <p>
                  The faucet checks the allowlist, verifies your wallet
                  signature, and:
                </p>
                <ul className="hiw-sublist">
                  <li>sends a small amount of rao to your stealth address;</li>
                  <li>
                    computes a deterministic{' '}
                    <strong>nullifier</strong> ={' '}
                    <code>HMAC-SHA256(secret, proposalId ‖ realAddress)</code>;
                  </li>
                  <li>
                    signs a credential{' '}
                    <code>
                      anon-vote-cred:v1:&lt;proposal&gt;:&lt;stealth&gt;:&lt;nullifier&gt;
                    </code>{' '}
                    with the coordinator key.
                  </li>
                </ul>
                <p>
                  The real address is never stored next to the nullifier.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">4</div>
              <div>
                <strong>Cast the vote from the stealth wallet</strong>
                <p>
                  The stealth wallet submits a{' '}
                  <code>system.remark</code> extrinsic whose body is the
                  credential plus the choice. The extrinsic is signed by the
                  stealth key — there is no on-chain trace of your real wallet.
                </p>
              </div>
            </li>
            <li>
              <div className="hiw-step-num">5</div>
              <div>
                <strong>Anyone can verify the tally</strong>
                <p>
                  The UI scans all remarks and, for each, checks that the
                  extrinsic signer matches the declared stealth address, the
                  coordinator signature is valid, and the nullifier hasn't been
                  seen before (one vote per voter). The result is a publicly
                  verifiable count — with no way to tell who voted for what.
                </p>
              </div>
            </li>
          </ol>

          <div className="hiw-caveat">
            <strong>Trust note.</strong> Anonymity relies on the coordinator
            not retaining a <code>realAddress → nullifier</code> mapping on
            its side. Against the public chain and the UI, unlinkability is
            cryptographic.
          </div>
        </div>
      </div>
    </div>
  );
}
