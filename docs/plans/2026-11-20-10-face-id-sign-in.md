# Plan 10: Signing in again with Face ID

Agreed with the owner on 2026-11-20. Not built yet.

**Goal:** when an iOS account's session ends, signing in again takes a glance, not the password. Sessions end after 90 days unused, a year after they began, when the account is signed out from another device, and when its password is reset ([accounts-and-access.md](../server/accounts-and-access.md#2-sessions-and-tokens)). Today the app then shows Sign in with the username filled in, and the password has to be typed.

## What was considered

- **The password in the Keychain, behind Face ID (chosen).** The app keeps the password the account typed in a Keychain item that only a Face ID match on this device opens, and signs in with it as if it had been typed. This is iOS only, with no server change.
- **A device key on the server.** A Secure Enclave key behind Face ID, its public key registered with the server, signing the server's challenge for a new session. No password would sit on the phone, and the server could revoke the key. It needs new endpoints, a table, contract fixtures and the web's Devices list too: several times the work, for a screen that comes up about once a year.
- **Passwords AutoFill alone.** The password field already offers the Passwords app's saved passwords, behind Face ID (`.textContentType(.password)`). Without a domain associated with the app, iOS can't match the entry to the server, and the user picks it from a list each time. Associated domains can't work here, because every self-hosted server has a domain of its own. Passkeys are ruled out for the same reason.
- **Not in this plan:** locking the app behind Face ID, and asking for Face ID to switch accounts. Either can come later on top of the same `Biometrics` wrapper.

## 1. Saving the password

- After a typed sign-in succeeds, the app asks **"Use Face ID to sign in next time?"** with **Not now** and **Use Face ID**, then opens the app. The same question follows a setup code redeemed (`RedeemView`) and a server claimed (`SetupView`): all three type a password, and all three go through `AddServerModel.finish`.
- The question appears only when the device has biometrics and they're set up (`LAContext.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`). Its words follow `LAContext.biometryType`: Face ID, Touch ID or Optic ID.
- Not now isn't remembered. The question comes again at the next typed sign-in, which is rare.
- **Use Face ID** saves the password as a generic password under the service `me.tracklistme.playarr.password`, with the account `<serverId>:<accountId>` (the token's key, `AccountKey.keychainAccount`). Its access control is `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` with `.biometryCurrentSet`. So:
  - only a match with the faces or fingers enrolled now opens it;
  - it isn't in backups or iCloud Keychain;
  - removing the passcode or enrolling another face makes iOS delete it.
- Saving it takes no Face ID prompt; reading it does.

## 2. Signing in again

- When the active account is signed out (`RootView` → `AddServerFlow(start: .server(_, username:))` → `SignInView`) and a password is saved for it, the screen leads with **Sign in with Face ID**, the biometry's symbol beside it. Below it go **Use password instead**, which shows the username and password fields as today, and **I have a setup code**.
- Face ID is asked once on its own as the screen appears. The button asks again.
- After a match, the saved password goes through `API.Auth.signIn`, as a typed one would, to the same address (`AddServerModel.connected.url`). The device name and platform are the same, and `ServerStore.signedIn` is the same.
- The prompt's reason, shown under Touch ID (Face ID shows the usage description instead), is "Sign in to <server name>".

## 3. When it fails

| What happens | What the app does |
|---|---|
| Face ID cancelled, or no match | Nothing changes. The button and Use password instead stay. |
| The server answers 401 to the sign-in (the password was changed or reset, or the account is gone) | Deletes the saved password and opens the password field: "Your password has changed. Type the new one." |
| The item is gone or can't be opened (a face enrolled, the passcode removed: `errSecItemNotFound`, `errSecAuthFailed`) | Deletes what's left of it and opens the password field: "Face ID changed on this iPhone. Type your password." (the biometry's name, and "iPad" on an iPad) |
| Offline, 429 Too many tries, or a server error | Keeps the saved password and shows the error, as a typed sign-in does |

## 4. Forgetting it

- **Sign out** (`ServerStore.signOut`, from the account switcher or Settings) deletes the saved password with the token and the account.
- A session ending (`ServerStore.markSignedOut`) keeps it, since this is what it's for.
- In Settings → Accounts, beside **Sign out on this device**, **Forget Face ID sign-in** shows while a password is saved for the account. It deletes the password with a toast (`ToastCenter.removed`). To turn it on again, type the password at the next sign-in.
- The demo, and the in-memory stores used by UI tests and previews, never save one.

**A consequence to know.** An admin who signs out a lost phone from the account's devices doesn't stop whoever holds it from signing in again. They still need the owner's face, and a password reset stops it for good, since the next try gets a 401 and deletes the password.

## 5. Code

- **`PlayarrAPI`**
  - `PasswordVault`, a protocol beside `SecretStore`: `hasPassword(for:)`, `save(_:for:)`, `password(for:reason:)` (async; reading it asks for Face ID), and `remove(for:)`.
  - `KeychainPasswordVault` implements it. `InMemoryPasswordVault` is the version for tests, with a switch for each failure in section 3.
  - `ServerStore` takes a vault, and `signOut` removes the password.
- **`PlayarrUI`**
  - `Biometrics`: what the device has (`none`, `faceID`, `touchID`, `opticID`), its name and its symbol. It's a protocol with a live and a fixed implementation, so tests and screenshots can pick one.
  - `AddServerModel`:
    - after a typed password, `offerFaceID` holds the password until the question is answered;
    - `signInWithFaceID()` reads the password and signs in;
    - it handles the failures in section 3.
  - `SignInView`: the question as an alert before `onDone`, and the Face ID button and its fallback.
  - The Accounts panel: Forget Face ID sign-in.
- **App:** `NSFaceIDUsageDescription` in `Config/Info.plist`: "Playarr uses Face ID to sign you in again when a session ends." No entitlement. `LocalAuthentication` needs no required-reason entry in the privacy manifest.

## 6. Tests and checks

- **`PlayarrAPITests`:** `ServerStore.signOut` removes the saved password, and `markSignedOut` keeps it.
- **`PlayarrUITests` (the package):** `AddServerModel` with `InMemoryPasswordVault` and a fixed `Biometrics`. Each case:
  - the question after a sign-in, a redeem and a claim, and none without biometrics;
  - Use Face ID saves the password, and Not now saves nothing;
  - Face ID signs in with the saved password;
  - a 401 deletes the password and opens the field with its line;
  - a vanished item does the same with its line;
  - a cancel keeps the password;
  - offline and 429 keep the password and show the error;
  - Forget Face ID sign-in deletes the password.
- **Screen tour:** the sign-in screen with Face ID (`14x-sign-in-face-id`), on the iPhone and the iPad.
- **On a real iPhone** (added to the [device checklist](2026-11-05-ios-device-checklist.md)): XCUITest can't drive Face ID. Check that the question appears, that a glance signs in after a session is ended from another device, that enrolling another face drops the password, and Touch ID on an iPad or an iPhone SE.
- **Docs:** [ios/README.md](../ios/README.md) (Finding servers and signing in), a line in [decisions.md](../decisions.md), and this plan's progress.
