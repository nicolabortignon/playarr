# Playarr

**Your own music streaming service, for the music you already own.**

Playarr turns the music collection on your home server into something that feels like Spotify or Apple Music. Open it in a browser or on your iPhone, search, press play, and it just works, at home or away. Everyone in the household gets their own account, their own playlists and their own mixes.

It works with [Lidarr](https://lidarr.audio), with plain folders of music, or both.

## Why Playarr

Lidarr is great at collecting music, but it can't play any of it. Playarr is the player Lidarr is missing. It also lets anyone in the house add music, without needing to learn Lidarr.

## What you get

### <img src="docs/images/icons/smartphone.svg" width="22" height="22" alt=""> A player for every screen

- **Any browser, any device.** Desktop or phone, with nothing to install. On a phone, add it to the home screen and it behaves like an app, with lock-screen controls.
- **A native iPhone and iPad app**, on its way to the App Store.
- **The things you'd expect.** Gapless albums, crossfades, a sleep timer, synced lyrics, keyboard shortcuts, and colours that follow the album art.
- <img src="docs/images/icons/download.svg" width="16" height="16" alt=""> **Offline listening.** Download albums, playlists, mixes or your favourites. The next few songs in the queue are always saved ahead, so a patchy connection doesn't interrupt the music.

### <img src="docs/images/icons/blend.svg" width="22" height="22" alt=""> Songs that flow like a DJ set

Turn on **DJ mix** and Playarr blends each song into the next, on the beat, the way a DJ would. Songs with a matching tempo and key get a long, smooth blend. Songs that don't match get a quick, clean mix. Albums played in order are left alone. It works on a locked iPhone too, and in **Party** mode the blends get longer and come more often. If a song's beat lands in the wrong place, you can fix its mix points by hand.

### <img src="docs/images/icons/volume.svg" width="22" height="22" alt=""> Every song at the same volume

**Even volume** levels every song to the same loudness, so a quiet 70s record and a loud modern single sit side by side without you reaching for the volume. Albums played in order keep their own dynamics.

### <img src="docs/images/icons/sparkles.svg" width="22" height="22" alt=""> Made for you

- <img src="docs/images/icons/lucky.svg" width="16" height="16" alt=""> **Feeling lucky.** One press on Home and Playarr puts together 15 songs that suit the hour. Press again for a new set.
- <img src="docs/images/icons/dices.svg" width="16" height="16" alt=""> **Rediscover.** Twelve albums pulled at random from your library, reshuffled with a tap.
- **Twelve mixes on Home**, built from what you actually listen to: Discovery Weekly, On Repeat, Vibes of the hour, Blast from the past, Deep cuts, Fresh arrivals, genre and decade mixes, Energy boost, Deep focus, Wind down and On this day.
- <img src="docs/images/icons/radio.svg" width="16" height="16" alt=""> **Radio.** When the queue runs out, similar songs from your library keep playing.
- <img src="docs/images/icons/stats.svg" width="16" height="16" alt=""> **Your listening stats.** Top artists, songs and albums, when you listen most, and a year in review.
- **ListenBrainz**, if you'd like your plays scrobbled there.
- <img src="docs/images/icons/palette.svg" width="16" height="16" alt=""> **Playlist covers** drawn from how the songs in each playlist actually sound.

### <img src="docs/images/icons/search.svg" width="22" height="22" alt=""> Find and request music, without opening Lidarr

- **Search for a song, not a release.** Type "bohemian rhapsody" and Playarr finds the original song, works out which album it's on, and offers to request that album.
- **See what you already have.** Search results show what's already in the library, ready to play.
- <img src="docs/images/icons/request.svg" width="16" height="16" alt=""> **Request in one tap.** Playarr asks Lidarr for just that album, not the artist's whole discography, and shows the download's progress until it's ready to play.
- **Discover from your playlists.** "Songs like these" under each playlist suggests similar music to add or request.

Nobody needs a Lidarr account or to know about quality profiles. Lidarr stays an admin tool, and Playarr is where people find and ask for music.

### <img src="docs/images/icons/users.svg" width="22" height="22" alt=""> Everyone gets their own

- **One account per person**, each with its own favourites, playlists, history and mixes. A playlist can be shared with everyone on the server.
- **You decide who hears what.** Admins choose which music each person can hear and whether they may request albums.
- **Easy invites.** Hand someone a one-time setup code and they choose their own password.

### <img src="docs/images/icons/library.svg" width="22" height="22" alt=""> Your music, wherever it lives

- **Many sources.** Lidarr's library, folders on the server, another computer over SSH, or a network share on a NAS, Windows PC or Mac.
- **Messy folders welcome.** Untagged albums are identified automatically, by name or by their sound. Compilations are split up so each song joins the album it first came out on. Anything Playarr isn't sure about waits for you to confirm.
- **Optional tidying.** Playarr can propose moving files into neat Artist / Album / Track folders. You choose which moves to apply, and every change can be undone. It never touches your files on its own.

### <img src="docs/images/icons/lock.svg" width="22" height="22" alt=""> Private by design

Your music, your accounts and your listening history all stay on your server. Your apps only ever talk to Playarr, and your Lidarr key never leaves the server.

## Getting started

Playarr runs as a single Docker container, ideally on the same machine as Lidarr:

```bash
docker build -f docker/Dockerfile -t playarr .
docker run -d --name playarr -p 4000:4000 \
  -e LIDARR_URL=http://lidarr:8686 -e LIDARR_API_KEY=... \
  -e PATH_MAP=/data/media/music=/data/media/music \
  -v /path/to/music:/data/media/music:ro \
  -v "$HOME/Music:/host:ro" \
  -v "$PWD/config:/config" -v "$PWD/cache:/cache" \
  playarr
```

Mount your music at the same path Lidarr uses (read-only is fine). Any folder under `/host` can be added later as a source.

1. **Open Playarr** at `http://<your-server>:4000` from your home network.
2. **Claim it.** In Settings → Accounts, set up the owner's account. Until you do, anyone who can reach Playarr can use it, so claim it before opening it to the internet.
3. **Add your music** in Settings → Sources, if Lidarr alone isn't enough.
4. **Invite your household** from Settings → Accounts.
5. **Listen away from home** by putting Playarr behind a reverse proxy with HTTPS.

Keep `/config` and back it up: it holds accounts, playlists, history and song analysis. `/cache` can be deleted at any time.

Playarr can also keep itself up to date (Settings → Updates). That, every setting, and how to recover a forgotten owner password are covered in [running and deploying Playarr](docs/server/updates-and-deploy.md).

## What's next

- The iPhone and iPad app on the App Store
- Smaller streams for mobile data, and support for formats some browsers can't play
- ReplayGain tags and an equaliser

See [what's planned](docs/plans/open-items.md) for the full list.

## For developers

Playarr is a TypeScript monorepo: a Fastify server, a React web app, and shared packages, including the DJ mixing engine. There's also a native SwiftUI app for iPhone and iPad.

```bash
corepack enable
pnpm install
pnpm dev        # server on :4000, web app on :5180
```

The [docs](docs/README.md) explain how every part works: the [architecture](docs/architecture.md), [building and deploying](docs/server/updates-and-deploy.md), the [web app](docs/web.md), the [iOS app](docs/ios/README.md), [DJ mixing](docs/mixing.md), and the [decisions behind it all](docs/decisions.md).
