# WHOOP pending-login status

The importer lives outside this repository in the health vault. These patches preserve the reviewed source delta and synthetic regression tests. They do not change the shared toollog helper.

Apply both patches from the vault root with `patch -F0 -p1` in a private copy; never apply to live files in place. Expected hashes:

- whoop/whoop.py: base `5e7d5effc1923d14397f6a2c67cc9ea98aaacab8db4914e0e6d2fcf6848f3294`, candidate `57ee154f507601ae7966a87f957cb816cf42896b03c8e2d6cb1f3c568e989b3c`.
- test_whoop_reauth.py: base `be995865df33c2b24982003748796ac18d597b0184e4b724aeda5a7804790544`, candidate `7a2ae0a7764cba00f1a79e633ce6342364cbe58628e37f3e94aa5e55f2f5b470`.

Synthetic checks: `HEALTH_VAULT_TEST_COPY=1 /usr/bin/python3 -B -m unittest -v test_whoop_reauth test_toollog test_error_detail`. Review and the normal vault base-hash/backup/atomic install procedure precede release.
