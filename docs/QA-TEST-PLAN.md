# TWIGA Android quality and release test plan

## What CI currently proves
- Gradle unit tests pass.
- Debug APK and optimized release APK assemble.
- Android emulator smoke tests launch the local receptionist workspace, verify the launcher intent and check that core permissions are declared (after the emulator job is enabled).
- These checks do **not** prove real SIM call handling, carrier forwarding, voice-provider connectivity, background installation, WhatsApp delivery, Google OAuth, or live business booking.

## Automated test matrix
| Area | Automated check | Required device/service test |
|---|---|---|
| Build | Debug + minified release assemble | Install release APK on a clean device |
| Launch | Emulator activity smoke test | Cold start, warm start, process death |
| Permissions | Manifest permission assertions | Deny, allow, revoke and re-grant each permission |
| Dialler | Launcher intent resolves | Set as default dialler; incoming/outgoing SIM calls on each supported OEM |
| Calls | Existing unit tests | Answer, reject, mute, speaker, Bluetooth, dual-SIM, call waiting, emergency-call coexistence |
| AI voice | Not covered by current emulator tests | Provider credentials, microphone, network loss, latency, interruption, English/Kiswahili/code-switching and human handover |
| Updates | Manifest/build parsing in app | Install older signed build, publish newer build, download, verify signature, user approval and rollback |
| Data | Local model/unit checks | Persistence, backup/restore, logout, workspace isolation and deletion |
| Battery/background | Not proven by CI | Doze, battery saver, OEM autostart restrictions, reboot and background limits |
| Accessibility | Not yet covered | TalkBack, font scaling, contrast, touch target and landscape/tablet layouts |

## Physical device test protocol
Run on Android 10, 11, 12, 13, 14, 15 and 16 where available, with at least one Samsung, Tecno, Infinix, Xiaomi/Redmi and Pixel/AOSP device. Record exact model, Android build, SIM operator and test timestamp.

1. Install the release APK fresh; verify package ID, version code, signer and SHA-256.
2. Grant each permission individually; repeat with deny, don't ask again and later revoke.
3. Request default dialler role and verify Android's role UI; cancel and re-request.
4. Make/receive ordinary SIM calls; check call UI, audio route, Bluetooth, dual-SIM, call waiting, decline and hang-up.
5. Confirm the app does not claim to hear or answer SIM audio unless a separately supported carrier/OEM/telephony route is configured.
6. Test AI browser/WebRTC voice separately from SIM calls; validate mic prompt, TLS, network interruption, reconnection, transcript, mute and end-call.
7. Test customer/order creation, editing, app restart, storage full, malformed data and data export/deletion.
8. Test update checks with no network, bad manifest, lower/equal/new build, wrong signature, insufficient storage, installer permission off/on and an active call.
9. Measure idle battery use over 8 and 24 hours; test Doze, battery saver, reboot and OEM background restrictions.
10. Verify no secrets in APK/resources/logs; inspect exported components, WebView origins, network TLS and backup policy.
11. Verify user consent before recording or follow-up, and verify retention/deletion behavior.
12. Capture screenshots, logcat excerpts and pass/fail evidence for every test.

## Release gate
Do not describe a feature as production-ready until its automated checks and required physical-device/service checks are recorded as passing. Emulator tests cannot certify carrier-specific PSTN audio behaviour. Never silently install an APK when Android requires user confirmation.
