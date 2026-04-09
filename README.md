# AnonVote — Anonymous Polkadot Voting

Cryptographically anonymous voting with on-chain identity verification.  
Votes are stored as JSON files in a GitHub repository. No backend required.

1. When you voted. Your browser fetched the drand public key and encrypted your choice locally. The ciphertext was saved to GitHub.

2. Nobody can decrypt anything. The decryption key doesn't exist yet — drand hasn't published the beacon for that round.

3. After the deadline - drand publishes the beacon. The Results tab automatically fetches it and decrypts all votes simultaneously in every browser.

Run app:
```
nvm exec npm i
nvm exec npm run dev
```

Live Demo: https://evgeny-s.github.io/anonym-vote/