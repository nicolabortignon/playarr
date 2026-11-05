# iOS: what to check on a real iPhone or iPad

The simulator can't check the items below. Their code is in the TestFlight builds; each line says what to do and what should happen. Tick them off here, or tell Claude which ones fail.

## iPhone

- [ ] **Every screen turns.** Turn the phone on Home, an album, an artist, a playlist, a mix, Library, Search and Queue. Each page turns and keeps working. Albums, playlists and mixes open as a gatefold, with the artwork fixed on the left and the page scrolling beside it. The artist's photo band is lower. Home's greeting and Feeling lucky share a row.
- [ ] **Now Playing sideways.** Open Now Playing with the phone on its side. On the left are the cover, the seek bar, then shuffle, previous, play/pause, next and repeat, all reachable with the left thumb. On the right are one header line (close, playing from with the time left, sleep timer, lyrics, ⋯) and the tracklist at full height, for the right thumb. Lyrics replace the tracklist in the same place.
- [ ] **The stage.** Leave sideways Now Playing alone for 12 seconds while it plays. The controls fade and the cover grows. A touch brings everything back.
- [ ] **Turn to open** (Settings → Appearance → Held sideways, off by default). With it on and a song queued, turning the phone opens Now Playing instead of turning the page. With Portrait Orientation Lock on, nothing turns or opens.
- [ ] **Screen stays on while charging.** In a stand or on a charger, sideways Now Playing keeps the screen on. Off the charger, it sleeps as usual.
- [ ] **Haptics.** These tap: play/pause, shuffle, repeat, the lyrics toggle, reordering the queue, dropping songs, and toasts. With System Haptics off, nothing taps.
- [ ] **Siri and Shortcuts.** "Play my favorites in Playarr", "I'm feeling lucky in Playarr" and "Start radio from this song in Playarr" each work. The three appear in the Shortcuts app and can go on the Action button. With nothing playing, Start radio says "Nothing playing."
- [ ] **Launch and icon.** Opening the app shows no white flash. The dark and tinted Home Screen icons look right.
- [ ] **Bold Text and Increase Contrast.** Text gets bolder, and secondary text gets brighter.

## iPad

- [ ] **Escape** on a hardware keyboard closes Now Playing. With a keyboard attached, `TEST_RUNNER_PLAYARR_DEVICE_CHECKS=1` also runs `testEscapeClosesNowPlaying`.
- [ ] **The keyboard.** Space, ←/→, Shift+←/→, ↑/↓ (volume, also while the sidebar has focus), M, S, L and / work as on the web. Holding ⌘ lists them.
- [ ] **Pointer.** Cards, rows and bar buttons highlight under it without lifting. A secondary click opens a song's or album's menu.
- [ ] **Drag.** A song dropped on one of your playlists in the sidebar shows "Added “…” to “…”". A shared playlist refuses it. Dropped on Queue, it shows "Added 1 track to queue".
- [ ] **Narrow windows.** At a third, a half and two thirds in Split View, in Slide Over, and in a small Stage Manager window, the app uses the phone's tabs and mini player with the same page open. Back at full screen, the sidebar returns with that page selected.
- [ ] **Coming back where you were.** Open an album and Now Playing, go Home, and use other apps until iOS closes Playarr in the background. Playarr comes back on that album. A force-quit opens on Home. With `TEST_RUNNER_PLAYARR_RESTORE=1`, `testComesBackWhereItWas` checks this.
- [ ] **VoiceOver.** The rotor's Headings jump between sections. A song row reads its title, artist and time, and offers its actions. The sidebar says which item is selected.

## Both

- [ ] **Buttons.** Play, Shuffle, Feeling lucky, Try again, New mix and the rest look like the Request button: DM Mono, upper case, in a capsule.
- [ ] **Offline** (the phase 7 list in `2026-11-04-ios-status.md`): downloads, airplane mode, keep-ahead, out of space.
