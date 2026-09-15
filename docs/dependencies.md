# Dependency notes

- `scripts/xcode_toolchain.py` works around the [Xcode 26.6 compiler-probe deadlock](https://github.com/swiftlang/swift-build/pull/1315). Local and EAS builds share it. It changes generated build files only and runs only on the affected Xcode version. Test it with `python3 -m unittest discover -s scripts/tests`.
- The `xcode@3.0.1` override selects `uuid@11.1.1`, which retains the CommonJS API used by the Xcode parser and fixes [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
- Expo Router 57 depends on an older URL decoder affected by [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr). The patched decoder changes module format and breaks the current `query-string` dependency. Update when Expo provides a compatible dependency version; do not force `npm audit fix --force`, which proposes downgrading Expo Router.
